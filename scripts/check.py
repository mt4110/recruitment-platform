#!/usr/bin/env python3
"""Deterministic local/CI checks; installs and dependency audits are separate."""
import ast
from pathlib import Path
import subprocess
ROOT = Path(__file__).resolve().parents[1]
def run(*args):
    subprocess.run(args, cwd=ROOT, check=True)
run('cargo','fmt','--manifest-path','services/api/Cargo.toml','--','--check')
run('cargo','clippy','--manifest-path','services/api/Cargo.toml','--locked','--all-targets','--','-D','warnings')
run('cargo','test','--manifest-path','services/api/Cargo.toml','--locked')
run('npm','run','typecheck','--prefix','apps/web')
run('node','apps/web/node_modules/typescript/bin/tsc','--project','e2e/tsconfig.json')
# Syntax validation does not write pyc or execute fixture helpers.
for folder in ('scripts','services/av','services/pdf-renderer','services/document-worker','e2e'):
    for path in sorted((ROOT/folder).glob('*.py')):
        ast.parse(path.read_text(), filename=str(path))
for folder,pattern in (('scripts','*.cjs'),('e2e','*.cjs'),('services/document-worker','*.cjs'),('services/pdf-renderer','*.mjs')):
    for path in sorted((ROOT/folder).glob(pattern)):
        run('node','--check',str(path))
print('Rust format/lint/tests, TypeScript and Python/Node syntax: passed')
