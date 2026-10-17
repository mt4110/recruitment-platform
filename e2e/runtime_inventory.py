"""Verify updated runtimes by image ID. Never inspect environment or credentials."""
import json
import os
import re
import subprocess
from pathlib import Path

instance = os.environ['RP_INSTANCE']
assert re.fullmatch(r'e2e-[a-z0-9-]+', instance)
folder = Path(os.environ['RP_E2E_DIR']) / 'artifacts'

def output(args):
    return subprocess.check_output(args, text=True, timeout=30).strip()

def version(text):
    match = re.search(r'(\d+)\.(\d+)\.(\d+)', text)
    assert match, 'VERSION_UNAVAILABLE'
    return tuple(map(int, match.groups()))

node = """const fs=require('node:fs');console.log(JSON.stringify({node:process.versions.node,openssl:process.versions.openssl,npm_present:fs.existsSync('/usr/local/bin/npm')||fs.existsSync('/usr/bin/npm'),npm_tree_present:fs.existsSync('/usr/local/lib/node_modules/npm')||fs.existsSync('/usr/lib/node_modules/npm'),node_license:fs.existsSync('/usr/local/share/doc/node/LICENSE')}))"""
python = """import sys,json,pyexpat,ssl,importlib.util,pikepdf,PIL,lxml.etree as e
print(json.dumps({'python':sys.version.split()[0],'executable':sys.executable,'expat':pyexpat.EXPAT_VERSION,'pyexpat_module':pyexpat.__file__,'libxml':e.LIBXML_VERSION,'qpdf':pikepdf.__libqpdf_version__,'pillow':PIL.__version__,'openssl':ssl.OPENSSL_VERSION,'pip_present':importlib.util.find_spec('pip') is not None,'ensurepip_present':importlib.util.find_spec('ensurepip') is not None}))"""
browser = """const fs=require('node:fs'),cp=require('node:child_process'),p=require('playwright').chromium.executablePath();console.log(JSON.stringify({playwright:require('playwright/package.json').version,executable:p,chromium:cp.execFileSync(p,['--version'],{encoding:'utf8'}).trim(),npm_present:fs.existsSync('/usr/bin/npm')||fs.existsSync('/usr/local/bin/npm')}))"""
services = ['gateway','web','api','db','idp','idp-db','pdf-renderer','invoice-renderer','artifact-viewer','scan','updater','document-broker','document-relay','document-sandbox']
seen = {}
report = {'scope':'M6 updated runtime versions and package boundaries; not vulnerability clearance','roles':{},'status':'failed'}
for role in services:
    name = f'recruitment-{instance}-{role}-1'
    ephemeral = role.startswith('document-')
    if ephemeral:
        tag = f'recruitment-{instance}-'+('document-broker' if role=='document-relay' else role)
        image = output(['docker','image','inspect','--format','{{.Id}}',tag])
    else:
        image = output(['docker','inspect','--format','{{.Image}}',name])
    row = {'image_id':image,'architecture':output(['docker','image','inspect','--format','{{.Architecture}}',image])}
    report['roles'][role] = row
    if image in seen:
        row['same_as'] = seen[image]
        continue
    # Job images are built from the same qualified Node/Python Dockerfiles.
    # If that changes, add a controlled probe before accepting another image.
    assert not ephemeral, 'UNPROBED_JOB_IMAGE'
    seen[image] = role
    def run(*args):
        return output(['docker','exec',name,*args])
    if role in ('web','artifact-viewer'):
        row['node'] = json.loads(run('node','-e',node))
        assert row['node']['node']=='24.22.0' and not row['node']['npm_present'] and not row['node']['npm_tree_present'] and row['node']['node_license']
    elif role=='pdf-renderer':
        row['python'] = json.loads(run('python','-c',python))
        row['browser'] = json.loads(run('node','-e',browser))
        assert row['python']['python']=='3.13.16' and row['python']['executable'].startswith('/usr/local/bin/')
        assert version(row['python']['expat']) >= (2,9,0)
        assert not row['python']['pip_present'] and not row['python']['ensurepip_present']
        row['pyexpat_linkage'] = run('ldd',row['python']['pyexpat_module'])
        assert 'libexpat.so.1 => /usr/local/lib/' in row['pyexpat_linkage']
        assert row['browser']['playwright']=='1.64.1'
    elif role=='gateway':
        row['libexpat'] = run('sh','-c',"awk '/^P:libexpat$/{p=1;next} p&&/^V:/{print;exit}' /lib/apk/db/installed")
        assert version(row['libexpat']) >= (2,9,0)
    elif role=='db':
        row['postgres'] = run('postgres','--version')
        row['gosu'] = run('gosu','--version')
        assert '17.11' in row['postgres'] and row['gosu'].startswith('1.19 ') and re.search(r'go1\.27\.2(?:[ ;)]|$)',row['gosu'])
    elif role=='scan':
        row['clamav'] = run('clamd','--version')
        row['libexpat'] = run('dpkg-query','-W','-f=${Version}', 'libexpat1')
        row['python_expat'] = run('python3','-c','import pyexpat;print(pyexpat.EXPAT_VERSION)')
        assert row['clamav'].startswith('ClamAV 1.5.4') and row['libexpat']=='2.9.0-1~deb13u1'
        assert version(row['python_expat']) >= (2,9,0)
    elif role=='idp':
        # Capture only Java's version output, not startup configuration.
        row['java'] = run('sh','-c','java -version 2>&1')
    elif role=='api':
        row['libc'] = run('dpkg-query','-W','-f=${Version}','libc6')
report['status'] = 'passed'
(folder/'runtime-versions.json').write_text(json.dumps(report,indent=2)+'\n')
print('M6 runtime versions and package boundaries: passed')
