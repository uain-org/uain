import json, csv, collections, glob, os, re
def mem_mb(s):
    v = s.split('/')[0].strip()
    n = float(re.match(r'[\d.]+', v).group())
    return n * (1024 if 'GiB' in v else 1 if 'MiB' in v else 1/1024)
for d in ['round1', 'round2', 'round3', '.']:
    for f in sorted([g for g in glob.glob(f'{d}/summary-*.json') if re.search(r'-\d+\.json$', g)], key=lambda x: (x.split('-')[1], int(re.findall(r'(\d+)\.json', x)[0]))):
        prof, n = re.findall(r'summary-(\w+)-(\d+)\.json', f)[0]
        m = json.load(open(f))['metrics']
        dur = m['http_req_duration']; fails = m['http_req_failed'].get('value', 0) * 100
        drop = m.get('dropped_iterations', {}).get('count', 0)
        mon = f'{d}/monitor-{prof}-{n}.csv'
        cpu = collections.defaultdict(list); mem = collections.defaultdict(float); lock = [0]
        if os.path.exists(mon):
            for r in csv.reader(open(mon)):
                if len(r) >= 5 and r[1] == 'stats' and 'loadtest' in r[2]:
                    k = r[2].replace('uain-loadtest-', ''); cpu[k].append(float(r[3].rstrip('%'))); mem[k] = max(mem[k], mem_mb(r[4]))
                if len(r) >= 3 and r[1] == 'lock_waiting' and r[2].strip(): lock.append(int(r[2]))
        pil = [k for k in cpu if k.startswith('pilot')]
        pcpu = sum(sum(cpu[k])/len(cpu[k]) for k in pil) / max(1, len(pil))
        pmem = max([mem[k] for k in pil] or [0])
        dbc = sum(cpu['db-1'])/len(cpu['db-1']) if cpu['db-1'] else 0
        print(f"{d:7} {prof:8} {n:>6} copies={len(pil)} reqs={m['http_reqs']['rate']:.0f}/s med={dur['med']:.0f} p95={dur['p(95)']:.0f} p99={dur['p(99)']:.0f} fail={fails:.2f}% dropped={drop} pilotCPU={pcpu:.0f}% pilotMem={pmem:.0f}MB dbCPU={dbc:.0f}% dbMem={mem['db-1']:.0f}MB lockmax={max(lock)} dur={m['iteration_duration']['max']/1000:.0f}s")
