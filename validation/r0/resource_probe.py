"""Isolated OS resource limits; does not qualify the future XLSX parser."""
import json,pathlib,platform,signal,subprocess,sys,time
def main():
    cases={
      'memory':'import resource;resource.setrlimit(resource.RLIMIT_AS,(128*1024*1024,)*2)\ntry:\n x=bytearray(512*1024*1024)\nexcept MemoryError:\n print("bounded");raise SystemExit(42)',
      'cpu':'import resource;resource.setrlimit(resource.RLIMIT_CPU,(1,1))\nwhile True: pass',
      'wall':'import time;time.sleep(10)',
    };result={}
    for name,code in cases.items():
      start=time.monotonic()
      try:
        p=subprocess.run([sys.executable,'-c',code],capture_output=True,text=True,timeout=2)
        result[name]={'exit':p.returncode,'bounded':(p.returncode==42 if name=='memory' else p.returncode in {-signal.SIGKILL,-signal.SIGXCPU}),'seconds':round(time.monotonic()-start,3),'stderr':p.stderr[-300:]}
      except subprocess.TimeoutExpired:
        result[name]={'timeout':True,'bounded':name=='wall','seconds':round(time.monotonic()-start,3)}
    result['scope']='POSIX child-process limits only; not future XLSX parser performance'
    result['platform']={'system':platform.system(),'machine':platform.machine()}
    pathlib.Path(sys.argv[1]).write_text(json.dumps(result,indent=2));print(json.dumps(result))
if __name__=='__main__':main()
