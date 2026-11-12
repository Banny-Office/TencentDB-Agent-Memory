"""Read parity and concurrent-write probe. Writes ONLY to an explicit loopback copy.

Run on the service host against independently cloned data volumes. Never point
--copy at production. Only hashes, timings and counts are written to the report.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import threading
import time
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--production', default='http://127.0.0.1:8424')
parser.add_argument('--copy', required=True)
parser.add_argument('--allow-write-to-copy', action='store_true')
parser.add_argument('--report', required=True)
args = parser.parse_args()
copy_url = urllib.parse.urlsplit(args.copy)
if copy_url.hostname not in ['127.0.0.1', 'localhost'] or copy_url.port in [None, 8424, 8125]:
    raise SystemExit('copy must use a separate loopback port')
if args.copy.rstrip('/') == args.production.rstrip('/'):
    raise SystemExit('production and copy must differ')
headers = {'Content-Type': 'application/json', 'X-Tdai-Service-Id': 'default'}
if os.environ.get('KNOWLEDGE_SERVICE_KEY'):
    headers['Authorization'] = 'Bearer ' + os.environ['KNOWLEDGE_SERVICE_KEY']

def request(origin, route, body=None, timeout=15):
    req = urllib.request.Request(origin + route, headers=headers,
        data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        value = json.load(response)
    if body is not None and value.get('code') != 0:
        raise RuntimeError('upstream business error')
    return value

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

wikis = ['wiki-xot2bcfn', 'wiki-zz5wwtdt', 'wiki-r4q7lcay', 'wiki-udc0x6e4']
queries = ['隐私', '账号交易', '色情', '诈骗', '正常', '审核', '例外', '__no_match_isolation__']
checks = []
for wiki in wikis:
    for query in queries:
        body = {'wiki_id': wiki, 'query': query, 'limit': 8}
        old = request(args.production, '/v3/wiki/search', body)['data']
        new = request(args.copy, '/v3/wiki/search', body)['data']
        if old != new:
            raise RuntimeError('search parity mismatch: ' + wiki)
        checks.append({'wiki': wiki, 'kind': 'search', 'sha256': digest(old)})
        refs = [item['path'] for item in old.get('results', [])[:2]]
        if refs:
            body = {'wiki_id': wiki, 'refs': refs}
            old = request(args.production, '/v3/wiki/page/read', body)['data']
            new = request(args.copy, '/v3/wiki/page/read', body)['data']
            if old != new:
                raise RuntimeError('body parity mismatch: ' + wiki)
            checks.append({'wiki': wiki, 'kind': 'body', 'sha256': digest(old)})

report = {'parityChecks': len(checks), 'parity': checks}
if args.allow_write_to_copy:
    stopping = threading.Event()
    timings = []
    errors = []
    read_body = {'wiki_id': 'wiki-r4q7lcay', 'refs': ['wiki/standard/full-standard.md']}
    search_body = {'wiki_id': 'wiki-zz5wwtdt', 'query': '隐私', 'limit': 8}
    expected_body = request(args.copy, '/v3/wiki/page/read', read_body)['data']
    expected_search = request(args.copy, '/v3/wiki/search', search_body)['data']

    def poll(kind):
        while not stopping.is_set():
            start = time.monotonic()
            try:
                if kind == 'health':
                    value = request(args.copy, '/health', timeout=2)
                    if value.get('status') != 'ok': raise RuntimeError('unhealthy')
                elif kind == 'read':
                    value = request(args.copy, '/v3/wiki/page/read', read_body, timeout=2)['data']
                    if value != expected_body: raise RuntimeError('body changed')
                else:
                    value = request(args.copy, '/v3/wiki/search', search_body, timeout=2)['data']
                    if value != expected_search: raise RuntimeError('search changed')
                timings.append((kind, round((time.monotonic() - start) * 1000, 2)))
            except Exception as error:
                errors.append({'kind': kind, 'error': type(error).__name__})
            stopping.wait(.1)

    writes = []
    stamp = str(time.time_ns())
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(poll, kind) for kind in ['health', 'read', 'search']]
        try:
            for batch in range(3):
                pages = [{'ref': f'wiki/tests/isolation-{stamp}-{batch}-{i}.md',
                    'content': f'# isolationtoken{stamp}\n' + '独立写入与查询隔离验证内容。' * 200} for i in range(20)]
                start = time.monotonic()
                result = request(args.copy, '/v3/wiki/page/write', {'team_id': 'team-5x9sbd20oi',
                    'wiki_id': 'wiki-udc0x6e4', 'pages': pages}, timeout=120)
                writes.append({'pages': len(result['data']['items']), 'ms': round((time.monotonic() - start) * 1000, 2)})
                # A successful ACK must make new content searchable immediately.
                found = request(args.copy, '/v3/wiki/search', {'wiki_id': 'wiki-udc0x6e4',
                    'query': f'isolationtoken{stamp}', 'limit': 8})['data']['results']
                if not found: raise RuntimeError('write ACK without searchable content')
        finally:
            stopping.set()
            for future in futures: future.result()
    report.update({'writes': writes, 'readErrors': errors, 'readSamples': len(timings), 'latency': {}})
    for kind in ['health', 'read', 'search']:
        values = sorted(ms for name, ms in timings if name == kind)
        report['latency'][kind] = {'count': len(values), 'p95ms': values[min(len(values)-1, int(len(values)*.95))] if values else None,
            'maxms': max(values) if values else None}
with open(args.report, 'w') as target:
    json.dump(report, target, ensure_ascii=False, indent=2)
print(json.dumps({key: value for key, value in report.items() if key != 'parity'}, ensure_ascii=False))
if args.allow_write_to_copy and report['readErrors']:
    raise SystemExit('concurrent query probe failed; see report')
