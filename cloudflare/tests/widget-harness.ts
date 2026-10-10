import type { Trip } from "../../src/domain.js";
import { summarizeThresholds } from "../src/thresholds.js";

const sampleTrip: Trip = {
  id: "11111111-1111-4111-8111-111111111111",
  store: "Supermarket",
  currency: "EUR",
  timezone: "Europe/Dublin",
  createdAt: "2026-10-10T12:00:00.000Z",
  checkedOutAt: null,
  status: "active",
  thresholdsCents: [2500, 5000],
  items: [
    { name: "Milk", unitPriceCents: 219 },
    { name: "Sourdough bread", unitPriceCents: 350 },
    { name: "Apples", unitPriceCents: 249 },
  ].map((item, i) => ({
    ...item,
    id: `22222222-2222-4222-8222-22222222222${i}`,
    quantity: 1,
    unit: "each",
    thresholdEligible: true,
    consumed: false,
    expiry: null,
    notes: "",
  })),
};

/** Isolated, in-memory bridge simulator, never shipped in the real widget. */
export function widgetHarness(widget: string) {
  const json = (value: unknown) =>
    JSON.stringify(value).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Basket Wise — local sample preview</title>
<style>body{margin:0;padding:16px;font:14px system-ui;background:#eee;color:#222}header{max-width:760px;margin:0 auto 16px}header p{margin:6px 0}button{font:inherit;margin:4px 4px 4px 0;padding:8px}iframe{display:block;width:100%;max-width:760px;margin:auto;border:0;border-radius:12px;height:300px}body[data-theme=dark]{background:#111;color:#eee}</style></head><body>
<header><strong>Local sample preview — not ChatGPT</strong><p>Sample data only. Nothing is saved or sent to Basket Wise.</p><button id="theme">Toggle theme</button><button id="sample">Load sample basket</button><button id="empty">Empty guest</button></header>
<iframe id="widget" title="Basket Wise sample widget" sandbox="allow-scripts allow-same-origin"></iframe>
<script>
const frame = document.getElementById('widget');
const trip = ${json(sampleTrip)};
const initialBasket = ${json(summarizeThresholds(sampleTrip))};
window.calls = [];
window.current = {dataEpoch:'sample-epoch',expiresAt:Date.now()+86400000,profileExpiresAt:Date.now()+90*86400000,spaceId:'local-sample-only',revision:1,basket:structuredClone(initialBasket)};
window.theme = 'light';
window.pendingReply = null;
window.holdCalls = false;
window.nextError = null;
window.sizeUpdates = [];
const post = message => frame.contentWindow.postMessage({jsonrpc:'2.0',...message}, '*');
window.deliver = result => post({method:'ui/notifications/tool-result',params:{content:[],structuredContent:result}});
window.setTheme = theme => {window.theme=theme;document.body.dataset.theme=theme;post({method:'ui/notifications/host-context-changed',params:{theme}})};
const snapshot = () => ({content:[],structuredContent:structuredClone(window.current)});
window.addEventListener('message',event => {
 if(event.source !== frame.contentWindow) return;
 const message=event.data;
 if(message.method==='ui/initialize') post({id:message.id,result:{protocolVersion:message.params.protocolVersion,hostInfo:{name:'Local sample host',version:'1'},hostCapabilities:{serverTools:{}},hostContext:{theme:window.theme}}});
 if(message.method==='ui/notifications/initialized') window.ready=true;
 if(message.method==='ui/notifications/size-changed'){ window.sizeUpdates.push(message.params);frame.style.height=message.params.height+'px'; }
 if(message.method==='tools/call') {
   window.calls.push(message.params);
   const reply = () => {
    if(window.nextError){const error=window.nextError;window.nextError=null;post({id:message.id,result:error});return;}
    const {name,arguments:args}=message.params;
    if(name==='start_trip') window.current={...window.current,revision:window.current.revision+1,basket:{...structuredClone(initialBasket),items:[],totalCents:0,thresholdSubtotalCents:0}};
    if(name==='add_item') {
     const b=window.current.basket;
     const line={...trip.items[0],id:'sample-'+window.calls.length,name:args.name,unitPriceCents:args.unitPriceCents,lineTotalCents:args.unitPriceCents};
     b.items.push(line); b.totalCents+=args.unitPriceCents;window.current.revision++;
    }
    if(name==='clear_baskets') window.current={...window.current,basket:null,revision:window.current.revision+1,dataEpoch:'cleared-epoch'};
    if(name==='delete_guest'){post({id:message.id,result:{content:[],structuredContent:{deleted:true}}});return;}
    post({id:message.id,result:snapshot()});
   };
   if(window.holdCalls)window.pendingReply=reply;else reply();
 }
});
document.getElementById('theme').onclick=()=>window.setTheme(window.theme==='light'?'dark':'light');
document.getElementById('sample').onclick=()=>{window.current.basket=structuredClone(initialBasket);window.current.revision++;window.deliver(window.current)};
document.getElementById('empty').onclick=()=>{window.current.basket=null;window.current.revision++;window.deliver(window.current)};
frame.srcdoc=${json(widget)};
</script></body></html>`;
}

export function shoppingListHarness(widget: string) {
  const list = {
    spaceId: "local-sample-only",
    shoppingListRevision: 1,
    profileExpiresAt: Date.now() + 90 * 86400000,
    alreadyApplied: false,
    shoppingList: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Milk",
        quantity: 2,
        unit: "each",
        notes: "For breakfast",
      },
    ],
  };
  return widgetHarness(widget)
    .replace(
      "window.theme = 'light';",
      `window.list = ${JSON.stringify(list)}; window.theme = 'light';`,
    )
    .replace("const snapshot = () =>", "const snapshot = (name) =>")
    .replace(
      "structuredClone(window.current)});",
      "structuredClone(name?.includes('shopping_list') ? window.list : window.current)});",
    )
    .replace(
      "const {name,arguments:args}=message.params;",
      `const {name,arguments:args}=message.params;
      if(name==='add_shopping_list_item') { window.list.shoppingList.push({...args,id:'sample-'+window.calls.length}); window.list.shoppingListRevision++; }
      if(name==='update_shopping_list_item') { const item=window.list.shoppingList.find(x=>x.id===args.itemId); Object.assign(item,args.patch); window.list.shoppingListRevision++; }
      if(name==='remove_shopping_list_item') { window.list.shoppingList=window.list.shoppingList.filter(x=>x.id!==args.itemId); window.list.shoppingListRevision++; }
      if(name==='add_item' && args.shoppingListItemId) {window.list.shoppingList=window.list.shoppingList.filter(x=>x.id!==args.shoppingListItemId); window.list.shoppingListRevision++; window.current.shoppingListRevision=window.list.shoppingListRevision; window.current.consumedShoppingListItemId=args.shoppingListItemId;}`,
    )
    .replace("result:snapshot()", "result:snapshot(name)");
}
