#!/usr/bin/env python3
"""Operator-only key rotation/revocation. Retain all old keys and ciphertext."""
import argparse,os,re,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('purpose',choices=['original','artifact']);p.add_argument('action',choices=['enable','revoke','activate','rotate']);p.add_argument('--version',default=None);args=p.parse_args()
instance=os.environ.get('RP_INSTANCE','default')
if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',instance):raise SystemExit('Invalid instance.')
local=ROOT/'.local' if instance=='default' else ROOT/'.local'/instance
version=args.version or args.purpose+'-v1'
if not re.fullmatch(args.purpose+r'-v[1-9][0-9]{0,3}',version):raise SystemExit('Invalid key version.')
base=['python3','scripts/local.py','compose','exec','-T','db','psql','-U','postgres','-d','recruitment','-v','ON_ERROR_STOP=1']
if args.action=='rotate':
 if not args.version:raise SystemExit('Rotation requires a new explicit --version.')
 os.umask(0o077);ring=local/'keyring';ring.mkdir(mode=0o700,exist_ok=True)
 private=ring/(version+'.pem');public=ring/(version+'.public.pem')
 if private.exists() or public.exists() or version.endswith('-v1'):raise SystemExit('Key version already exists; retain it. No overwrite.')
 subprocess.run(['openssl','genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:3072','-out',str(private)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run(['openssl','pkey','-in',str(private),'-pubout','-out',str(public)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 material=''.join(s for s in public.read_text().splitlines() if not s.startswith('-'))
 sql=f"INSERT INTO document_key_versions(purpose,version,public_spki) VALUES('{args.purpose}','{version}','{material}');"
 action='activate'
else:sql='';action=args.action
if action=='activate':
 sql+=f"DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM document_key_versions WHERE purpose='{args.purpose}' AND version='{version}' AND enabled) THEN RAISE EXCEPTION 'key unavailable';END IF;END $$;UPDATE document_key_versions SET accept_upload=false WHERE purpose='{args.purpose}';UPDATE document_key_versions SET accept_upload=true WHERE purpose='{args.purpose}' AND version='{version}';"
else:sql+=f"UPDATE document_key_versions SET enabled={'true' if action=='enable' else 'false'} WHERE purpose='{args.purpose}' AND version='{version}';"
sql=f"BEGIN;SET ROLE app_migrator;{sql}INSERT INTO document_key_events(purpose,version,action) VALUES('{args.purpose}','{version}','{args.action}');COMMIT;"
subprocess.run(base,cwd=ROOT,input=sql,text=True,check=True,stdout=subprocess.DEVNULL)
print('Key policy updated; all original private keys and ciphertext retained.')
