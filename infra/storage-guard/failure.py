#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import sys
import subprocess
import time
s=importlib.util.spec_from_file_location('guard',Path(__file__).with_name('guard.py'))
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
g=m.Guard(m.read(m.DEFAULT_CONFIG))
unit=sys.argv[1]
result=subprocess.run(['systemctl','show',unit,'-p','Result','--value'],capture_output=True,text=True).stdout.strip()
if result in ('success','signal'):
    g.audit('service-interrupted',unit=unit,result=result)
    raise SystemExit(0)
g.audit('service-failed',unit=unit,result=result)
path=g.state/'failures.json'
failures=m.read(path,{})
recent=[t for t in failures.get(unit,[]) if t>time.time()-7200]+[time.time()]
failures[unit]=recent
m.atomic(path,failures)
if len(recent)>=3:
    g.notify('failure-'+unit,'Automatická údržba disku opakovaně nedoběhla. Data zůstala zachována a další pokus proběhne automaticky; běžící sessions pokračují.')
