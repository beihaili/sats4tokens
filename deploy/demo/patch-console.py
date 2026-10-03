#!/usr/bin/env python3
"""Patch new-api's compiled console frontend for the EU relay; the `console` nginx serves the result.

new-api has no option for any of these, so three of the image's JS files are rewritten:
  - index.<h>.js   UI language = the visitor's own choice (localStorage) or English, never the browser's
                   (fallbackLng is en; upstream would show Chinese to every zh browser).
  - wallet chunk   the "Custom Amount" field is typed and shown in the display currency (€) instead of top-up
                   units (1 unit = ¥1 = €0.1333 here): € ÷ rate → whole units, the "Pay" box shows the exact
                   price. Minimum labels too. The rate is the one the wallet already uses (USDExchangeRate = Price).
  - keys chunk     API Keys page: a "Base URL <server_address>/v1" copy button next to "Create API Key", and the
                   row menu's "Copy Connection Info" (a JSON blob for setting up another new-api's channel)
                   becomes "Copy Base URL". Upstream added an "API Addresses" button in 2026-09 (after rc.22).
Patched files get new names (...-eur<sha>.js): Cloudflare and browsers keep /static/js/* for 7 days, so the
original names can't carry new code. nginx swaps the index name in the HTML (sub_filter, console/patch.conf);
the patched index points its chunk map at the patched chunks.

Every replacement must match exactly once. If one doesn't (another new-api image), nothing is patched:
patch.conf is emptied (= the original frontend) and the script exits 1. Re-run after changing NEW_API_IMAGE.
Usage on the server: ./patch-console.py   (reads new-api on 127.0.0.1:8530, writes ./console/)
"""
import hashlib
import os
import re
import subprocess
import sys
import urllib.request

NEWAPI = "http://127.0.0.1:8530"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "console")
SYMBOL = "€"
EUR = "Math.round({}*C*100)/100"  # units → display money, in the wallet component (C = its exchange rate prop)

# (original, patched) — wallet component eS(): c = amount in units, o = set units, W/B = input text, L = minimum
WALLET = [
    # input text starts as € and follows c, unless what was typed already means c (so "5" isn't rewritten to "5.07")
    ('[W,B]=(0,r.useState)(c.toString());(0,r.useEffect)(()=>{B(e=>""===e&&0===c?e:c.toString())},[c]);',
     '[W,B]=(0,r.useState)(""+' + EUR.format("c") + ');(0,r.useEffect)(()=>{B(e=>""===e&&0===c||'
     'Math.round((Number.parseFloat(e)||0)/C)===c?e:""+' + EUR.format("c") + ')},[c,C]);'),
    # typed € → nearest whole unit
    ('void((s=Number.parseInt(a)||0)>=0&&o(s))',
     'void((s=Math.round((Number.parseFloat(a)||0)/C))>=0&&o(s))'),
    ('min:L,placeholder:`Minimum ${L}`',
     'min:' + EUR.format("L") + ',step:"any",placeholder:`Minimum ' + SYMBOL + '${' + EUR.format("L") + '}`'),
    # pay-method buttons below the minimum
    ('n=r?O("Minimum topup amount: {{amount}}",{amount:s}):void 0,i=r?`${O("Minimum:")} ${s}`:void 0',
     'n=r?O("Minimum topup amount: {{amount}}",{amount:"' + SYMBOL + '"+' + EUR.format("s") + '}):void 0,'
     'i=r?`${O("Minimum:")} ' + SYMBOL + '${' + EUR.format("s") + '}`:void 0'),
]
# the console's API address, as upstream's own code finds it (status.server_address, else this origin)
BASE = ('(function(){try{let e=localStorage.getItem("status");if(e){let t=JSON.parse(e);if(t.server_address)'
        'return t.server_address}}catch{}return window.location.origin}()).replace(/\\/+$/,"")+"/v1"')
# API Keys page (module with es() = header buttons and the row actions menu): s = jsx, _ = Button, ep.l = copy,
# i.oR = toast, all module-level
KEYS = [
    ('function es(){let{t:e}=(0,l.Bd)(),{setOpen:t}=p();return(0,s.jsx)("div",{className:"flex gap-2",children:'
     '(0,s.jsxs)(_.$,{size:"sm",onClick:()=>t("create"),children:[(0,s.jsx)(ea.A,{className:"h-4 w-4"}),'
     'e("Create API Key")]})})}',
     'function es(){let{t:e}=(0,l.Bd)(),{setOpen:t}=p(),$u=' + BASE + ';return(0,s.jsxs)("div",'
     '{className:"flex flex-wrap gap-2",children:[(0,s.jsxs)(_.$,{size:"sm",variant:"outline",title:e("Copy"),'
     'onClick:async()=>{await (0,ep.l)($u)&&i.oR.success(e("Copied"))},children:[e("Base URL"),'
     '(0,s.jsx)("code",{className:"font-mono text-xs",children:$u})]}),'
     '(0,s.jsxs)(_.$,{size:"sm",onClick:()=>t("create"),children:[(0,s.jsx)(ea.A,{className:"h-4 w-4"}),'
     'e("Create API Key")]})]})}'),
    ('let e=I();if(!e)return;let t=(0,eq.G1)(e,function(){try{let e=localStorage.getItem("status");if(e){'
     'let t=JSON.parse(e);if(t.server_address)return t.server_address}}catch{}return window.location.origin}());'
     'await (0,ep.l)(t)&&i.oR.success(a("Copied"))},children:[a("Copy Connection Info")',
     'let t=' + BASE + ';await (0,ep.l)(t)&&i.oR.success(a("Copied"))},children:[a("Copy Base URL")'),
]
# async chunks to patch: (name, marker found in exactly one chunk, replacements)
CHUNKS = [("wallet", 'id:"topup-amount"', WALLET), ("keys", 'a("Copy Connection Info")', KEYS)]
INDEX = [('detection:{order:["localStorage","navigator"]', 'detection:{order:["localStorage"]')]


def get(path):
    with urllib.request.urlopen(NEWAPI + path, timeout=30) as r:
        return r.read().decode()


def replace_once(src, pairs, what):
    for old, new in pairs:
        n = src.count(old)
        if n != 1:
            raise SystemExit(f"{what}: expected 1 match, found {n}: {old[:70]}")
        src = src.replace(old, new)
    return src


def write(rel, data):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        f.write(data)
    os.replace(path + ".tmp", path)


def tag(data):
    return "-eur" + hashlib.sha256(data.encode()).hexdigest()[:8]


def main():
    html = get("/")
    index_name = re.search(r'/static/js/(index\.[0-9a-f]+)\.js', html).group(1)
    index = get(f"/static/js/{index_name}.js")
    # chunk map in the webpack runtime: c.u=e=>"static/js/async/"+e+"."+({1127:"bee1faa10b",...})[e]+".js"
    js_map = re.search(r'"static/js/async/"\+e\+"\."\+\(\{([^}]*)\}\)', index).group(1)
    chunks = dict(re.findall(r'(\d+):"([0-9a-f]+)"', js_map))
    sources = {k: get(f"/static/js/async/{k}.{h}.js") for k, h in chunks.items()}

    patched, index_pairs = {}, list(INDEX)  # patched: file path → content
    for name, marker, pairs in CHUNKS:
        ids = [k for k, src in sources.items() if marker in src]
        if len(ids) != 1:
            raise SystemExit(f"{name} chunk: expected 1 with {marker}, found {len(ids)}")
        cid, old_hash = ids[0], chunks[ids[0]]
        src = replace_once(sources[cid], pairs, name)
        new_hash = old_hash + tag(src)
        patched[f"static/js/async/{cid}.{new_hash}.js"] = src
        index_pairs.append((f'{cid}:"{old_hash}"', f'{cid}:"{new_hash}"'))  # chunk map entry
        print(f"{name} chunk {cid} → {new_hash}")
    index = replace_once(index, index_pairs, "index")
    index_new = index_name + tag(index)

    # files first, then the HTML switch; old patched files stay (an open tab may still load them)
    for rel, data in patched.items():
        write(rel, data)
    write(f"static/js/{index_new}.js", index)
    write("patch.conf", f"# written by patch-console.py: HTML loads the patched index\n"
                        f"sub_filter '/static/js/{index_name}.js' '/static/js/{index_new}.js';\n")
    print(f"console patched: {index_name} → {index_new}")


if __name__ == "__main__":
    try:
        main()
    except BaseException as e:  # incl. SystemExit from a failed match: serve the original frontend
        write("patch.conf", "# patch-console.py failed: original frontend\n")
        print(f"console NOT patched (original frontend served): {e}", file=sys.stderr)
        sys.exit(1)
    # reload nginx if it runs (it re-reads patch.conf); before the first `up` there is nothing to reload
    subprocess.run(["docker", "exec", "cashu-demo-console", "nginx", "-s", "reload"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
