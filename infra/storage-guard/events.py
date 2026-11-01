#!/usr/bin/env python3
"""Docker lifecycle observer, with bounded/coalesced inventory requests."""
import json
import subprocess
import time

last=0
with subprocess.Popen(['/usr/bin/docker','events','--filter','type=container','--format','{{json .}}'],
                      stdout=subprocess.PIPE,text=True) as p:
    for line in p.stdout:
        try:
            e=json.loads(line)
            name=e.get('Actor',{}).get('Attributes',{}).get('name','')
            if not (name.startswith('dev-') or name.startswith('dind-dev-')):
                continue
            if e.get('Action') not in ('start','die','destroy'):
                continue
            if time.time()-last<30:
                continue
            subprocess.run(['systemctl','start','--no-block','devbox-storage-inventory.service'],check=True)
            last=time.time()
        except (ValueError,subprocess.CalledProcessError):
            pass
raise SystemExit(1)  # systemd reconnects the event stream
