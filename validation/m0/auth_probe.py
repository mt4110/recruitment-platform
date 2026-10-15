"""Disposable OIDC protocol probe. No production app/API implementation."""
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from urllib.parse import urlencode,urlparse,parse_qs
import json,time,secrets,hashlib,base64,hmac,html
from pathlib import Path
import httpx,jwt

CONFIG=json.loads(Path('/probe/config.json').read_text())
ISSUER=CONFIG['issuer'];CLIENT='m0-probe';CALLBACK='http://localhost:18081/callback'
attempts={};sessions={};outcomes=[];csrf_secret=secrets.token_bytes(32)
http=httpx.Client(timeout=15,trust_env=False)
discovery=http.get(ISSUER+'/.well-known/openid-configuration');discovery.raise_for_status();discovery=discovery.json()
assert discovery['issuer']==ISSUER
jwks=http.get(discovery['jwks_uri']);jwks.raise_for_status();jwks=jwks.json()['keys']
def encoded(v):return base64.urlsafe_b64encode(v).decode().rstrip('=')
def validate(token,a):
    header=jwt.get_unverified_header(token)
    if header['alg']!='RS256':raise ValueError('algorithm')
    key=jwt.PyJWK.from_dict(next(k for k in jwks if k['kid']==header['kid'])).key
    claims=jwt.decode(token,key,algorithms=['RS256'],issuer=a.get('issuer',ISSUER),audience=a.get('audience',CLIENT),
      options={'require':['exp','iat','iss','aud','sub','nonce']})
    if not hmac.compare_digest(claims['nonce'],a['nonce']):raise ValueError('nonce')
    return claims

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass # never log callback URLs, auth codes, cookies, or tokens
    def reply(self,status,data,cookie=None):
        body=json.dumps(data).encode();self.send_response(status)
        self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store')
        if cookie:self.send_header('Set-Cookie',cookie)
        self.end_headers();self.wfile.write(body)
    def do_GET(self):
        u=urlparse(self.path);q={k:v[0] for k,v in parse_qs(u.query).items()}
        if u.path=='/login':
            state=secrets.token_urlsafe(32);nonce=secrets.token_urlsafe(32);verifier=secrets.token_urlsafe(48)
            case=q.get('case','normal');a={'verifier':verifier,'nonce':nonce,'created':time.time(),'case':case}
            params={'client_id':CLIENT,'redirect_uri':CALLBACK,'response_type':'code','scope':'openid profile',
              'state':state,'nonce':nonce,'code_challenge':encoded(hashlib.sha256(verifier.encode()).digest()),'code_challenge_method':'S256',
              'prompt':'login','login_hint':q.get('user','agency-a')}
            if case=='badstate':params['state']=secrets.token_urlsafe(32)
            if case=='badnonce':a['nonce']=secrets.token_urlsafe(32)
            if case=='badverifier':a['verifier']=secrets.token_urlsafe(48)
            if case=='badissuer':a['issuer']=ISSUER+'/wrong'
            if case=='badaudience':a['audience']='wrong-client'
            if case=='badredirect':params['redirect_uri']='http://localhost:18081/not-registered'
            if case=='nopkce':params.pop('code_challenge');params.pop('code_challenge_method')
            attempts[state]=a;self.send_response(302);self.send_header('Location',discovery['authorization_endpoint']+'?'+urlencode(params));self.end_headers();return
        if u.path=='/callback':
            a=attempts.pop(q.get('state',''),None)
            if not a or time.time()-a['created']>300:self.reply(400,{'error':'STATE_OR_ATTEMPT_INVALID'});return
            if q.get('error'):
                reason='PROVIDER_PKCE_REQUIRED' if 'code_challenge' in q.get('error_description','').lower() else 'PROVIDER_REJECTED'
                self.reply(400,{'error':reason});return
            try:
                r=http.post(discovery['token_endpoint'],data={'grant_type':'authorization_code','client_id':CLIENT,'code':q.get('code',''),
                  'redirect_uri':CALLBACK,'code_verifier':a['verifier']})
                if r.status_code!=200:self.reply(400,{'error':'TOKEN_EXCHANGE_REJECTED'});return
                token=r.json()['id_token']
                if a['case']=='badsignature':
                    parts=token.split('.');parts[2]=('A' if parts[2][0]!='A' else 'B')+parts[2][1:];token='.'.join(parts)
                claims=validate(token,a)
                if a['case']=='expired':
                    time.sleep(max(0,claims['exp']-time.time()+1));claims=validate(token,a)
                identity=ISSUER+'|'+claims['sub'];member=CONFIG['members'].get(identity)
                if not member or not member['active'] or not member['org_active']:self.reply(403,{'error':'MEMBERSHIP_REJECTED'});return
                sid=secrets.token_urlsafe(32);key=hashlib.sha256(sid.encode()).hexdigest()
                sessions[key]={'subject':claims['sub'],'organization':member['organization'],'username':member['username'],'expires':time.time()+28800}
                outcomes.append({'case':a['case'],'user':member['username'],'issuer_verified':True,'audience_verified':True,'signature_verified':True,'nonce_verified':True})
                self.reply(200,{'status':'M0_AUTH_OK','user':member['username'],'organization':member['organization']},
                  'm0sid='+sid+'; HttpOnly; SameSite=Lax; Path=/');return
            except (jwt.PyJWTError,ValueError,StopIteration) as e:
                self.reply(400,{'error':type(e).__name__ if isinstance(e,jwt.PyJWTError) else 'NONCE_OR_KEY_INVALID'});return
        if u.path=='/me':
            from http.cookies import SimpleCookie
            cookie=SimpleCookie();cookie.load(self.headers.get('Cookie',''));sid=cookie.get('m0sid')
            key=hashlib.sha256(sid.value.encode()).hexdigest() if sid else ''
            s=sessions.get(key)
            valid=s and s['expires']>time.time()
            self.reply(200 if valid else 401,{'user':s['username'],'organization':s['organization'],'csrf_token':hmac.new(csrf_secret,sid.value.encode(),'sha256').hexdigest()} if valid else {'error':'NO_SESSION'});return
        if u.path=='/results':self.reply(200,{'issuer':ISSUER,'discovery_matches':True,'completed_flows':outcomes});return
        self.reply(404,{'error':'NOT_FOUND'})
    def do_POST(self):
        from http.cookies import SimpleCookie
        if urlparse(self.path).path!='/logout':self.reply(404,{'error':'NOT_FOUND'});return
        cookie=SimpleCookie();cookie.load(self.headers.get('Cookie',''));sid=cookie.get('m0sid')
        if not sid:self.reply(401,{'error':'NO_SESSION'});return
        expected=hmac.new(csrf_secret,sid.value.encode(),'sha256').hexdigest()
        if self.headers.get('Origin')!='http://localhost:18081' or not hmac.compare_digest(self.headers.get('X-CSRF-Token',''),expected):
            self.reply(403,{'error':'CSRF'});return
        sessions.pop(hashlib.sha256(sid.value.encode()).hexdigest(),None)
        self.reply(200,{'status':'logged_out'},'m0sid=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/')

print('M0 OIDC probe ready',flush=True)
ThreadingHTTPServer(('0.0.0.0',18081),Handler).serve_forever()
