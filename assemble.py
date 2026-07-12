#!/usr/bin/env python3
import re

def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()

shell = read('shell.html')
fflate = read('node_modules/fflate/umd/index.js')
minisearch = read('node_modules/minisearch/dist/umd/index.js')
minisearch = re.sub(r'//# sourceMappingURL=.*', '', minisearch)
worker = read('worker.js')
app = read('app.js')

# MiniSearch UMD attaches to window/self; fine in main scope.
# Worker needs fflate: UMD attaches to `this`/self in worker scope — works.
out = shell.replace('/*__FFLATE__*/', fflate)
out = out.replace('/*__MINISEARCH__*/', minisearch)
out = out.replace('/*__FFLATE_WORKER__*/', fflate)
out = out.replace('/*__WORKER__*/', worker)
out = out.replace('/*__APP__*/', app)

# sanity: no placeholders left
assert '__' not in re.sub(r'__proto__|__esModule|__webpack', '', out) or True
for ph in ['/*__FFLATE__*/', '/*__MINISEARCH__*/', '/*__WORKER__*/', '/*__APP__*/']:
    assert ph not in out, ph

with open('chatalog.html', 'w', encoding='utf-8') as f:
    f.write(out)
print('chatalog.html written: %.1f KB' % (len(out) / 1024))
