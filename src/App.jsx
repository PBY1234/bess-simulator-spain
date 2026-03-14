import { useState, useMemo, useCallback, useEffect } from "react";
import {
  LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
  ComposedChart, Area
} from "recharts";

const SCENARIOS = [
  { gw:0,  label:"Base",  color:"#94a3b8" },
  { gw:1,  label:"1 GW",  color:"#6366f1" },
  { gw:3,  label:"3 GW",  color:"#f59e0b" },
  { gw:5,  label:"5 GW",  color:"#10b981" },
  { gw:10, label:"10 GW", color:"#ef4444" },
];

const fmt = (n, d=0) => {
  if (n == null || !isFinite(n)) return "--";
  return Number(n).toLocaleString("es-ES", { minimumFractionDigits:d, maximumFractionDigits:d });
};
const fmtE = n => {
  if (n == null || !isFinite(n)) return "--";
  const abs = Math.abs(n), s = n < 0 ? "-" : "";
  if (abs >= 1e9) return s+"EUR"+(abs/1e9).toFixed(2)+"B";
  if (abs >= 1e6) return s+"EUR"+(abs/1e6).toFixed(2)+"M";
  if (abs >= 1e3) return s+"EUR"+(abs/1e3).toFixed(1)+"k";
  return s+"EUR"+abs.toFixed(0);
};
function parseEU(s) {
  if (s==null) return NaN;
  const t=String(s).trim(); if(!t) return NaN;
  const hasDot=t.includes("."),hasComma=t.includes(",");
  if(hasDot&&hasComma) return t.lastIndexOf(".")>t.lastIndexOf(",") ? parseFloat(t.replace(/,/g,"")) : parseFloat(t.replace(/\./g,"").replace(",","."));
  if(hasComma) return parseFloat(t.replace(",","."));
  return parseFloat(t);
}
function parseHour(s) {
  if(!s) return NaN;
  const m=String(s).trim().match(/^H(\d+)/i);
  return m ? parseInt(m[1]) : parseInt(String(s).trim());
}
function findCol(hds, tests) {
  for(const test of tests) for(let i=0;i<hds.length;i++) if(test(hds[i])) return i;
  return -1;
}

/* ═══════════════ PARSERS ═══════════════ */
function parseMarginalPDBC(text) {
  const lines=text.replace(/\r/g,"\n").split("\n").map(l=>l.trim()).filter(Boolean);
  const rr=[];
  for(const line of lines){
    if(line.startsWith("MARGINALPDBC")||line.startsWith("*")) continue;
    const p=line.split(";"); if(p.length<5) continue;
    const y=parseInt(p[0]),mo=parseInt(p[1]),d=parseInt(p[2]),per=parseInt(p[3]),pr=parseFloat(p[4].replace(",","."));
    if(y>2000&&y<2100&&mo>=1&&mo<=12&&d>=1&&d<=31&&per>=1&&per<=96&&!isNaN(pr))
      rr.push({year:y,month:mo,day:d,period:per,price:pr});
  }
  const maxP=rr.reduce((m,r)=>Math.max(m,r.period),0);
  const isQH=maxP>24;
  const byDateHour={};
  rr.forEach(r=>{
    const ds=String(r.day).padStart(2,"0")+"/"+String(r.month).padStart(2,"0")+"/"+r.year;
    const hora=isQH?Math.floor((r.period-1)/4)+1:r.period;
    const key=ds+"|"+hora;
    if(!byDateHour[key]) byDateHour[key]={date:ds,hora,prices:[]};
    byDateHour[key].prices.push(r.price);
  });
  const slots=Object.values(byDateHour).map(s=>({
    date:s.date, hora:s.hora, price:s.prices.reduce((a,b)=>a+b,0)/s.prices.length
  }));
  if(slots.length>0){
    const nd=new Set(slots.map(s=>s.date)).size;
    return {slots,note:slots.length+" hourly slots, "+nd+" days"+(isQH?" (from 15-min)":"")};
  }
  return {slots:[],note:"Could not parse"};
}

function parseOMIECurva(text) {
  const lines=text.replace(/\r\n/g,"\n").replace(/\r/g,"\n").split("\n").filter(l=>l.trim());
  let hi=-1;
  for(let i=0;i<Math.min(20,lines.length);i++){const f=lines[i].split(";")[0].trim().toLowerCase();if(["hora","periodo","hour","period"].includes(f)){hi=i;break;}}
  if(hi<0) return {error:"Header not found"};
  const hd=lines[hi].split(";").map(h=>h.trim().toLowerCase().replace(/^"|"$/g,""));
  const iH=findCol(hd,[h=>["hora","periodo","hour","period"].includes(h)]);
  const iF=findCol(hd,[h=>h.includes("fecha")||h.includes("date")]);
  const iT=findCol(hd,[h=>h==="tipo oferta"||h==="tipo de oferta",h=>h.startsWith("tipo")&&!h.includes("log")]);
  const iE=findCol(hd,[h=>h.includes("acumul"),h=>h.includes("potencia"),h=>h.includes("energ"),h=>h.includes("mw")]);
  const iPr=findCol(hd,[h=>h.includes("precio"),h=>h.includes("price")]);
  let iOC=findCol(hd,[h=>h.includes("ofertada"),h=>h.includes("casada"),h=>h==="o/c"]);
  if(iOC===iT) iOC=-1;
  if([iH,iF,iT,iE,iPr].some(i=>i<0)) return {error:"Missing cols: "+hd.join("|")};
  const raw={},fl={total:0,accepted:0};
  for(let li=hi+1;li<lines.length;li++){
    const line=lines[li];if(line.startsWith("OMIE")||line.startsWith("*"))continue;
    const parts=line.split(";");if(parts.length<5)continue;fl.total++;
    const hora=parseHour(parts[iH]),fecha=(parts[iF]||"").trim();
    const tipo=(parts[iT]||"").trim().toUpperCase();
    const isSup=["V","SELL","S"].includes(tipo),isDem=["C","D","BUY","B"].includes(tipo);
    if(!isSup&&!isDem) continue;
    const mw=parseEU(parts[iE]),price=parseEU(parts[iPr]);
    if(isNaN(hora)||!fecha||isNaN(mw)||isNaN(price)||mw<0||price>3010||price<-490) continue;
    const oc=iOC>=0?(parts[iOC]||"").trim().toUpperCase():"n/a";
    if(iOC>=0&&oc!=="O") continue;
    fl.accepted++;
    if(!raw[fecha]) raw[fecha]={};
    if(!raw[fecha][hora]) raw[fecha][hora]={supply:[],demand:[],hora};
    if(isSup) raw[fecha][hora].supply.push({price,mw});
    else raw[fecha][hora].demand.push({price,mw});
  }
  const out={};
  for(const date of Object.keys(raw)){
    out[date]={};
    for(const hStr of Object.keys(raw[date])){
      const h=parseInt(hStr),{supply:sup,demand:dem,hora}=raw[date][hStr];
      sup.sort((a,b)=>a.price-b.price);dem.sort((a,b)=>b.price-a.price);
      let cs=0,cd=0;
      const supC=sup.map(s=>{cs+=s.mw;return{price:s.price,cumMW:cs};});
      const demC=dem.map(d=>{cd+=d.mw;return{price:d.price,cumMW:cd};});
      const inter=solveIntersection(supC,demC);
      out[date][h]={supply:supC,demand:demC,hora,...inter};
    }
  }
  out._diag={filterLog:fl};
  return out;
}

/* ═══════════════ MERIT ORDER ═══════════════ */
function extendFlat(c,mw){if(mw<=0)return c;const l=c.at(-1);return[...c,{price:l.price,cumMW:l.cumMW+mw}];}

function solveIntersection(sup,dem){
  if(!sup||!dem||sup.length<2||dem.length<2) return null;
  try{
    const step=(c,mw)=>{if(mw<=c[0].cumMW)return c[0].price;if(mw>c.at(-1).cumMW)return c.at(-1).price;let lo=0,hi=c.length-1;while(lo<hi){const m=(lo+hi)>>1;if(c[m].cumMW<mw)lo=m+1;else hi=m;}return c[lo].price;};
    const bp={};sup.forEach(s=>bp[s.cumMW]=1);dem.forEach(d=>bp[d.cumMW]=1);
    const mx=Math.min(sup.at(-1).cumMW,dem.at(-1).cumMW),mn=Math.max(sup[0].cumMW,dem[0].cumMW);
    const pts=Object.keys(bp).map(Number).filter(m=>m>=mn&&m<=mx).sort((a,b)=>a-b);
    if(!pts.length)return null;
    for(const mw of pts){if(step(sup,mw)>=step(dem,mw))return{clearPrice:Math.max(step(sup,mw),0),clearMW:mw};}
    let mg=Infinity,bm=pts[0],bp2=0;for(const mw of pts){const g=Math.abs(step(sup,mw)-step(dem,mw));if(g<mg){mg=g;bm=mw;bp2=(step(sup,mw)+step(dem,mw))/2;}}
    return{clearPrice:Math.max(bp2,0),clearMW:bm};
  }catch{return null;}
}

function thinCurve(c,N=50){if(c.length<=N)return c;const r=[c[0]];const s=(c.length-2)/(N-2);for(let i=1;i<N-1;i++)r.push(c[Math.round(i*s)]);r.push(c.at(-1));return r;}

function optimiseSlot(stack,bessMW,rt){
  if(!stack?.supply||stack.supply.length<2||!stack?.demand||stack.demand.length<2) return null;
  const br=solveIntersection(stack.supply,stack.demand);if(!br?.clearPrice) return null;
  const sup=thinCurve(stack.supply),dem=thinCurve(stack.demand);
  let bdP=br.clearPrice,bcP=br.clearPrice;
  const ss=sup.map(p=>({price:p.price,cumMW:p.cumMW+bessMW}));
  const ed=extendFlat(dem,bessMW);
  const dr=solveIntersection(ss,ed);
  if(dr) bdP=Math.max(0,dr.clearPrice);
  const sd=dem.map(p=>({price:p.price,cumMW:p.cumMW+bessMW}));
  const es=extendFlat(sup,bessMW);
  const cr=solveIntersection(es,sd);
  if(cr) bcP=Math.max(0,cr.clearPrice);
  return{basePrice:br.clearPrice,dischargePrice:bdP,chargePrice:bcP,marketMW:stack.supply.at(-1).cumMW};
}

/* ═══════════════ PROXY MODEL ═══════════════ */
const THERMAL_GAP = {
  1:11.7,2:10.3,3:9.7,4:9.3,5:9.3,6:9.9,7:11.6,8:13.9,9:12.9,10:8.1,
  11:4.9,12:2.4,13:1.3,14:1.7,15:1.4,16:1.3,17:3.4,18:4.5,
  19:7.8,20:12.2,21:16.5,22:17.8,23:16.0,24:13.4
};

function proxyPrice(spotPrice, bessMW, action, hora) {
  const tgGW = THERMAL_GAP[hora] || 10;
  const damGW = tgGW * 0.56;
  const bessGW = bessMW / 1000;
  if (action === "discharge") {
    const frac = Math.min(bessGW / Math.max(damGW, 0.3), 1.0);
    const steep = spotPrice > 60 ? 0.55 : spotPrice > 30 ? 0.65 : 0.8;
    const reduction = Math.pow(frac, steep);
    const floor = spotPrice * (1 - frac) * 0.3;
    return Math.max(0, spotPrice * (1 - reduction) + floor * reduction);
  } else {
    const totalAvailGW = 25 + (hora >= 10 && hora <= 16 ? 15 : 5);
    const headroomGW = Math.max(totalAvailGW - (tgGW + 7), 0);
    if (bessGW <= headroomGW) {
      const flatSlope = spotPrice < 10 ? 0.3 : 0.8;
      return spotPrice + bessGW * flatSlope;
    } else {
      const flatPart = headroomGW * 0.5;
      const steepGW = bessGW - headroomGW;
      const steepFrac = steepGW / Math.max(damGW, 2);
      const steepSlope = 3 + steepFrac * 10;
      return spotPrice + flatPart + steepGW * steepSlope;
    }
  }
}

/* ═══════════════ SCORE ALL HOURS ═══════════════ */
function scoreAllHours(dailySlots, curveStacks, rt, bessMW) {
  const scores = {};
  for (const date of Object.keys(dailySlots)) {
    const slots = dailySlots[date];
    for (const s of slots) {
      const key = date + "|" + s.hora;
      const stack = curveStacks?.[date]?.[s.hora] ?? null;
      if (stack) {
        const opt = optimiseSlot(stack, bessMW, rt);
        if (opt) {
          scores[key] = { date, hora: s.hora, spot: s.price, hasCurve: true,
            disP: opt.dischargePrice, chgP: opt.chargePrice, mktMW: opt.marketMW };
        }
      }
      if (!scores[key]) {
        scores[key] = { date, hora: s.hora, spot: s.price, hasCurve: !!stack,
          disP: proxyPrice(s.price, bessMW, "discharge", s.hora),
          chgP: proxyPrice(s.price, bessMW, "charge", s.hora),
          mktMW: null };
      }
    }
  }
  return scores;
}

/* ═══════════════ DAILY DISPATCH ═══════════════ */
function simulateDay(date, slots, scores, bessMW, bessH, rt, cyclesDay) {
  const MWh = bessMW * bessH;
  const maxDisHours = Math.round(cyclesDay * bessH);
  const maxChgHours = maxDisHours;
  const chrono = slots.slice().sort((a, b) => a.hora - b.hora);
  if (!chrono.length) return null;
  const hourData = chrono.map(s => {
    const key = date + "|" + s.hora;
    const sc = scores[key];
    return { hora: s.hora, spot: s.price, sc, key };
  }).filter(h => h.sc);
  const chgRank = hourData.slice().sort((a, b) => a.sc.chgP - b.sc.chgP);
  const disRank = hourData.slice().sort((a, b) => b.sc.disP - a.sc.disP);
  const pairs = [];
  for (const ch of chgRank.slice(0, maxChgHours * 4)) {
    for (const di of disRank.slice(0, maxDisHours * 4)) {
      if (di.hora <= ch.hora) continue;
      const margin = di.sc.disP * bessMW - (ch.sc.chgP * bessMW / rt);
      if (margin > 0) pairs.push({ ch, di, margin });
    }
  }
  pairs.sort((a, b) => b.margin - a.margin);
  const chgSet = new Set(), disSet = new Set();
  let nPairs = 0;
  for (const p of pairs) {
    if (nPairs >= maxDisHours) break;
    if (chgSet.has(p.ch.hora) || disSet.has(p.ch.hora)) continue;
    if (chgSet.has(p.di.hora) || disSet.has(p.di.hora)) continue;
    chgSet.add(p.ch.hora); disSet.add(p.di.hora); nPairs++;
  }
  if (nPairs === 0 && hourData.length >= 2) {
    const chgR2 = hourData.slice().sort((a, b) => a.sc.chgP - b.sc.chgP);
    const disR2 = hourData.slice().sort((a, b) => b.sc.disP - a.sc.disP);
    let nc = 0, nd2 = 0;
    for (const c of chgR2) { if (nc >= maxChgHours) break; if (disSet.has(c.hora)) continue; chgSet.add(c.hora); nc++; }
    for (const d of disR2) {
      if (nd2 >= maxDisHours) break;
      if (chgSet.has(d.hora)) continue;
      if ([...chgSet].some(ch => ch < d.hora)) { disSet.add(d.hora); nd2++; }
    }
  }
  let soc = 0, rev = 0, curves = 0;
  const trace = [];
  const spots = hourData.map(h => h.spot);
  const bMax = Math.max(...spots), bMin = Math.min(...spots);
  for (const h of hourData) {
    let act = "idle", adj = h.spot, mw = 0;
    if (chgSet.has(h.hora) && soc < MWh) {
      const stored = Math.min(bessMW * rt, MWh - soc);
      const actualMW = stored / rt;
      act = "charge"; adj = h.sc.chgP; mw = actualMW;
      rev -= actualMW * h.sc.chgP; soc = Math.min(MWh, soc + stored);
      if (h.sc.hasCurve) curves++;
    } else if (disSet.has(h.hora) && soc > 0) {
      const discharged = Math.min(bessMW, soc);
      act = "discharge"; adj = h.sc.disP; mw = discharged;
      rev += discharged * h.sc.disP; soc = Math.max(0, soc - discharged);
      if (h.sc.hasCurve) curves++;
    }
    trace.push({ hora: h.hora, spot: +h.spot.toFixed(2), adj: +adj.toFixed(2),
      mw: +mw.toFixed(0), mktMW: h.sc.mktMW, act, curve: h.sc.hasCurve,
      soc: Math.round(100 * soc / MWh) });
  }
  const peakHour = hourData.reduce((best, h) => h.spot > best.spot ? h : best, hourData[0]);
  const troughHour = hourData.reduce((best, h) => h.spot < best.spot ? h : best, hourData[0]);
  return { date, bMax, bMin, aMax: peakHour.sc.disP, aMin: troughHour.sc.chgP,
    bSpread: bMax - bMin, aSpread: Math.max(peakHour.sc.disP - troughHour.sc.chgP, 0),
    rev, curvePct: Math.round(100 * curves / Math.max(hourData.length, 1)),
    trace, endSoc: soc };
}

/* ═══════════════ LOAD PRELOADED DATA ═══════════════ */
// Converts the omie_data.json structure into the app's internal formats
function ingestPreloadedData(data, solveIntersectionFn) {
  // Prices → priceSlots
  const slots = [];
  for (const [date, hours] of Object.entries(data.prices || {})) {
    for (const [hora, price] of Object.entries(hours)) {
      slots.push({ date, hora: parseInt(hora), price: +price });
    }
  }
  slots.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.hora - b.hora);

  // Curves → curveStacks
  let stacks = null;
  const curveKeys = Object.keys(data.curves || {});
  if (curveKeys.length > 0) {
    stacks = {};
    for (const [date, hours] of Object.entries(data.curves)) {
      stacks[date] = {};
      for (const [hora, cd] of Object.entries(hours)) {
        const sup = (cd.s || []).map(([price, cumMW]) => ({ price: +price, cumMW: +cumMW }));
        const dem = (cd.d || []).map(([price, cumMW]) => ({ price: +price, cumMW: +cumMW }));
        if (sup.length < 2 || dem.length < 2) continue;
        const inter = solveIntersectionFn(sup, dem);
        stacks[date][parseInt(hora)] = { supply: sup, demand: dem, hora: parseInt(hora), ...inter };
      }
    }
  }
  return { slots, stacks };
}

/* ═══════════════ UI COMPONENTS ═══════════════ */
function Slider({ label, value, min, max, step, unit, onChange }) {
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-500">{label}</span>
        <span className="font-bold text-indigo-700">{fmt(value, step < 1 ? 2 : 0)} {unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))} className="w-full accent-indigo-600" />
    </div>
  );
}

const AC = { charge: "#10b981", discharge: "#ef4444", idle: "#e2e8f0" };

/* ═══════════════ MAIN APP ═══════════════ */
export default function App() {
  const [tab, setTab] = useState("simulate");
  const [resultTab, setResultTab] = useState("strip");
  const [priceSlots, setPriceSlots] = useState([]);
  const [priceStatus, setPriceStatus] = useState(null);
  const [curveStacks, setCurveStacks] = useState(null);
  const [curveStatus, setCurveStatus] = useState(null);
  const [bessH, setBessH] = useState(2);
  const [rt, setRt] = useState(0.88);
  const [cycD, setCycD] = useState(2);
  const [capex, setCapex] = useState(250);
  const [opex, setOpex] = useState(8);
  const [simRes, setSimRes] = useState(null);
  const [running, setRunning] = useState(false);
  const [runSt, setRunSt] = useState("");
  const [stripSc, setStripSc] = useState("1 GW");
  const [preloadStatus, setPreloadStatus] = useState("loading");

  // ── Auto-load reference year on startup ──────────────────────────────────
  useEffect(() => {
    // Try .gz first, fall back to .json
    const tryLoad = (url) =>
      fetch(url).then(r => {
        if (!r.ok) throw new Error(r.status);
        return r.json(); // browser auto-decompresses gzip if served with correct headers
      });

    tryLoad("https://bess-simulator-spain.vercel.app/omie_data.json.gz")
      .catch(() => tryLoad("https://bess-simulator-spain.vercel.app/omie_data.json"))
      .then(data => {
        const { slots, stacks } = ingestPreloadedData(data, solveIntersection);
        setPriceSlots(slots);
        const nd = new Set(slots.map(s => s.date)).size;
        setPriceStatus("2024 reference year · " + nd + " days · pre-loaded");
        if (stacks) {
          setCurveStacks(stacks);
          setCurveStatus("Pre-loaded · " + Object.keys(stacks).length + " days with curves");
        }
        setPreloadStatus("done");
      })
      .catch(err => {
        console.warn("Could not load preloaded data:", err);
        setPreloadStatus("error");
        setTab("upload");
      });
  }, []);

  const handlePriceFiles = useCallback(async files => {
    const arr = Array.from(files); let all = [], fail = 0;
    for (const f of arr) { try { const t = await f.text(); all = all.concat(parseMarginalPDBC(t).slots); } catch { fail++; } }
    const seen = {}, ded = [];
    for (const s of all) { const k = s.date + "|" + s.hora; if (!seen[k]) { seen[k] = 1; ded.push(s); } }
    setPriceSlots(ded);
    const nd = new Set(ded.map(s => s.date)).size;
    setPriceStatus("OK " + ded.length + " hourly slots, " + nd + " days, " + arr.length + " file(s)" + (fail ? ", " + fail + " failed" : ""));
    setPreloadStatus("overridden");
  }, []);

  const handleCurveFiles = useCallback(async files => {
    const all = {}; let ok = 0, fail = 0;
    for (const f of Array.from(files)) {
      try {
        const r = parseOMIECurva(await f.text());
        if (r.error) { fail++; continue; }
        Object.keys(r).filter(k => !k.startsWith("_")).forEach(d => { if (!all[d]) all[d] = {}; Object.assign(all[d], r[d]); });
        ok++;
      } catch { fail++; }
    }
    if (ok > 0) setCurveStacks(all);
    setCurveStatus(ok + " files, " + Object.keys(all).filter(k => !k.startsWith("_")).length + " days" + (fail ? ", " + fail + " failed" : ""));
  }, []);

  const onDropP = useCallback(e => { e.preventDefault(); const f = e.dataTransfer?.files || e.target?.files; if (f?.length) handlePriceFiles(f); }, [handlePriceFiles]);
  const onDropC = useCallback(e => { e.preventDefault(); const f = e.dataTransfer?.files || e.target?.files; if (f?.length) handleCurveFiles(f); }, [handleCurveFiles]);

  const daily = useMemo(() => {
    const d = {};
    priceSlots.forEach(s => { if (!d[s.date]) d[s.date] = []; d[s.date].push(s); });
    return d;
  }, [priceSlots]);

  const nDays = Object.keys(daily).length;
  const hasP = priceSlots.length > 0;

  const covPct = useMemo(() => {
    if (!curveStacks || !nDays) return null;
    const c = Object.keys(daily).filter(d => curveStacks[d]).length;
    return Math.round(100 * c / nDays);
  }, [curveStacks, daily, nDays]);

  const runSim = useCallback(() => {
    setRunning(true); setRunSt("Starting...");
    const allDates = Object.keys(daily).sort();
    setTimeout(() => {
      const out = {};
      out["Base"] = allDates.map(date => {
        const sl = daily[date]; let mx = -Infinity, mn = Infinity;
        sl.forEach(s => { mx = Math.max(mx, s.price); mn = Math.min(mn, s.price); });
        return { date, bMax: mx, bMin: mn, aMax: mx, aMin: mn, bSpread: mx - mn, aSpread: mx - mn, rev: 0, curvePct: 0,
          trace: sl.map(s => ({ hora: s.hora, spot: +s.price.toFixed(2), adj: +s.price.toFixed(2), mw: 0, mktMW: null, act: "idle", soc: 0 })) };
      });
      const bess = SCENARIOS.filter(s => s.gw > 0);
      let idx = 0;
      const next = () => {
        if (idx >= bess.length) { setSimRes(out); setTab("results"); setRunning(false); setRunSt(""); return; }
        const sc = bess[idx++]; const mw = sc.gw * 1000;
        setRunSt("Scoring " + sc.label + "...");
        setTimeout(() => {
          const scores = scoreAllHours(daily, curveStacks, rt, mw);
          setRunSt("Dispatching " + sc.label + "...");
          setTimeout(() => {
            out[sc.label] = allDates.map(d => simulateDay(d, daily[d], scores, mw, bessH, rt, cycD)).filter(Boolean);
            next();
          }, 0);
        }, 0);
      };
      next();
    }, 0);
  }, [daily, curveStacks, bessH, rt, cycD]);

  const stats = useMemo(() => {
    if (!simRes) return [];
    return SCENARIOS.map(sc => {
      const r = simRes[sc.label] || [], n = r.length || 1;
      let sm = 0, sn = 0, ss = 0, sr = 0, scv = 0;
      r.forEach(d => { sm += d.aMax || 0; sn += d.aMin || 0; ss += d.aSpread || 0; sr += d.rev || 0; scv += d.curvePct || 0; });
      return { ...sc, avgMax: sm / n, avgMin: sn / n, avgSpread: ss / n, annRev: sr * (365 / n), curvePct: Math.round(scv / n) };
    });
  }, [simRes]);

  const monthlyData = useMemo(() => {
    if (!simRes) return [];
    const mo = {};
    SCENARIOS.forEach(sc => {
      (simRes[sc.label] || []).forEach(d => {
        let m = "";
        if (d.date?.includes("/")) { const p = d.date.split("/"); if (p.length === 3) m = p[2] + "-" + p[1]; }
        else if (d.date?.includes("-")) m = d.date.slice(0, 7);
        if (!m) return;
        if (!mo[m]) mo[m] = { month: m.slice(5) };
        mo[m]["s_" + sc.label] = (mo[m]["s_" + sc.label] || 0) + (d.aSpread || 0);
        mo[m]["x_" + sc.label] = (mo[m]["x_" + sc.label] || 0) + (d.aMax || 0);
        mo[m]["n_" + sc.label] = (mo[m]["n_" + sc.label] || 0) + (d.aMin || 0);
        mo[m]["r_" + sc.label] = (mo[m]["r_" + sc.label] || 0) + (d.rev || 0);
        mo[m]["c_" + sc.label] = (mo[m]["c_" + sc.label] || 0) + 1;
      });
    });
    return Object.values(mo).sort((a, b) => a.month > b.month ? 1 : -1).map(m => {
      const o = { month: m.month };
      SCENARIOS.forEach(sc => { const n = m["c_" + sc.label] || 1;
        o["spread_" + sc.label] = +((m["s_" + sc.label] || 0) / n).toFixed(1);
        o["max_" + sc.label] = +((m["x_" + sc.label] || 0) / n).toFixed(1);
        o["min_" + sc.label] = +((m["n_" + sc.label] || 0) / n).toFixed(1);
        o["rev_" + sc.label] = +((m["r_" + sc.label] || 0) / 1e6).toFixed(2);
      });
      return o;
    });
  }, [simRes]);

  const stripData = useMemo(() => {
    if (!simRes || !daily) return null;
    const sc = SCENARIOS.find(s => s.label === stripSc) || SCENARIOS[1];
    const allDates = Object.keys(daily).sort();
    const agg = {};
    for (const date of allDates) {
      const res = (simRes[sc.label] || []).find(d => d.date === date);
      if (!res?.trace) continue;
      for (const t of res.trace) {
        if (!agg[t.hora]) agg[t.hora] = { spotS: 0, adjS: 0, votes: { charge: 0, discharge: 0, idle: 0 }, socS: 0, mwS: 0, mktS: 0, mktN: 0, n: 0 };
        const a = agg[t.hora]; a.spotS += t.spot; a.adjS += t.adj; a.votes[t.act]++; a.socS += t.soc; a.mwS += t.mw;
        if (t.mktMW != null) { a.mktS += t.mktMW; a.mktN++; }
        a.n++;
      }
    }
    const bars = Array.from({ length: 24 }, (_, i) => i + 1).map(h => {
      const a = agg[h]; if (!a || !a.n) return null;
      const v = a.votes;
      const act = sc.gw === 0 ? "idle" : (v.discharge >= v.charge ? (v.discharge > v.idle ? "discharge" : "idle") : (v.charge > v.idle ? "charge" : "idle"));
      return { h: String(h), spot: +(a.spotS / a.n).toFixed(2), adj: +(a.adjS / a.n).toFixed(2),
        act, soc: Math.round(a.socS / a.n), mw: +(a.mwS / a.n).toFixed(0),
        mkt: a.mktN > 0 ? +(a.mktS / a.mktN).toFixed(0) : null };
    }).filter(Boolean);
    return { label: "Avg " + allDates.length + " days · 24 hours", bars, sc };
  }, [simRes, daily, stripSc]);

  const shapeData = useMemo(() => {
    if (!simRes || !daily) return null;
    const allDates = Object.keys(daily).sort();
    const scenLines = SCENARIOS.map(sc => {
      const sum = {}, cnt = {};
      if (sc.gw === 0) {
        allDates.forEach(d => (daily[d] || []).forEach(s => { sum[s.hora] = (sum[s.hora] || 0) + s.price; cnt[s.hora] = (cnt[s.hora] || 0) + 1; }));
      } else {
        (simRes[sc.label] || []).forEach(r => {
          if (!r?.trace) return;
          r.trace.forEach(t => { sum[t.hora] = (sum[t.hora] || 0) + t.adj; cnt[t.hora] = (cnt[t.hora] || 0) + 1; });
        });
      }
      return { ...sc, hours: Array.from({ length: 24 }, (_, i) => i + 1).filter(h => cnt[h]).map(h => ({ h, avg: +(sum[h] / cnt[h]).toFixed(2) })) };
    });
    const chrono = Array.from({ length: 24 }, (_, i) => i + 1).map(h => {
      const r = { h: String(h) }; scenLines.forEach(sc => { const p = sc.hours.find(x => x.h === h); r[sc.label] = p ? p.avg : null; }); return r;
    });
    const N = chrono.length;
    const dur = Array.from({ length: N }, (_, i) => ({ pct: Math.round(100 * i / N) }));
    scenLines.forEach(sc => { const sorted = sc.hours.map(x => x.avg).sort((a, b) => a - b); sorted.forEach((v, i) => { if (i < N) dur[i][sc.label] = +v.toFixed(1); }); });
    return { chrono, dur };
  }, [simRes, daily]);

  const base = stats[0] || {};

  // ── Loading screen ────────────────────────────────────────────────────────
  if (preloadStatus === "loading") {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="text-4xl animate-pulse">⚡</div>
          <div className="text-indigo-700 font-bold text-lg">BESS Market Clearing Simulator</div>
          <div className="text-gray-500 text-sm">Loading 2024 OMIE reference data...</div>
          <div className="w-48 h-1.5 bg-gray-200 rounded-full mx-auto overflow-hidden">
            <div className="h-full bg-indigo-500 rounded-full animate-pulse" style={{width:"60%"}}/>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-50 min-h-screen p-3 font-sans text-sm text-gray-800">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-xl font-bold text-indigo-900 mb-0.5">BESS Market Clearing Simulator</h1>
        <p className="text-gray-400 text-xs mb-3">OMIE · Hourly resolution · Non-linear merit order · v21</p>

        <div className="flex gap-1 mb-4 flex-wrap">
          {["upload", "simulate", "results", "economics"].map(t => (
            <button key={t} onClick={() => setTab(t)} disabled={t !== "upload" && !hasP}
              className={"px-3 py-1.5 rounded-full text-xs font-semibold transition-all " + (tab === t ? "bg-indigo-600 text-white shadow" : "bg-white text-gray-500 hover:bg-indigo-50 border") + " disabled:opacity-30"}>
              {{ upload: "Data", simulate: "Simulate", results: "Results", economics: "P&L" }[t]}
            </button>
          ))}
        </div>

        {/* ═══ UPLOAD ═══ */}
        {tab === "upload" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-4">
              {preloadStatus === "done" && (
                <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-xs text-green-700">
                  ✅ <strong>2024 reference year pre-loaded.</strong> Upload your own files below to override.
                </div>
              )}
              <div onDrop={onDropP} onDragOver={e => e.preventDefault()} onClick={() => document.getElementById("fp").click()}
                className="border-2 border-dashed border-indigo-300 rounded-xl p-8 text-center cursor-pointer hover:bg-indigo-50 bg-white">
                <div className="text-3xl mb-2">📈</div>
                <div className="font-semibold text-indigo-700">Drop marginalpdbc files</div>
                <div className="text-xs text-gray-400 mt-1">Override pre-loaded data · hourly or 15-min</div>
                <input id="fp" type="file" accept=".csv,.txt,.1" className="hidden" multiple onChange={onDropP} />
              </div>
              {priceStatus && <div className="text-xs font-medium text-green-600">{priceStatus}</div>}
              <div onDrop={onDropC} onDragOver={e => e.preventDefault()} onClick={() => document.getElementById("fc").click()}
                className="border-2 border-dashed border-amber-300 rounded-xl p-8 text-center cursor-pointer hover:bg-amber-50 bg-white">
                <div className="text-3xl mb-2">📉</div>
                <div className="font-semibold text-amber-700">Drop curva_pbc files (optional)</div>
                <div className="text-xs text-gray-400 mt-1">Supply/demand curves · overrides pre-loaded curves</div>
                <input id="fc" type="file" accept=".csv,.txt,.1" className="hidden" multiple onChange={onDropC} />
              </div>
              {curveStatus && <div className="text-xs font-medium text-green-600">{curveStatus}{covPct != null && " · " + covPct + "% coverage"}</div>}
            </div>
            <div className="bg-white border rounded-xl p-4 space-y-3">
              <div className="font-semibold text-gray-700 text-xs uppercase">How it works</div>
              <div className="text-xs text-gray-500 space-y-2">
                <p>1. <strong>2024 OMIE data is pre-loaded</strong> — jump straight to Simulate</p>
                <p>2. Or upload your own files to use a different year</p>
                <p>3. The simulator models BESS fleets of 1–10 GW bidding into the Spanish day-ahead market</p>
                <p>4. Discharge adds supply → suppresses peak prices along the merit order</p>
                <p>5. Charge adds demand → lifts trough prices (especially during solar hours)</p>
              </div>
              {hasP && (
                <button onClick={() => setTab("simulate")} className="w-full bg-indigo-600 text-white rounded-lg py-2 text-xs font-semibold hover:bg-indigo-700">
                  Configure & run →
                </button>
              )}
            </div>
          </div>
        )}

        {/* ═══ SIMULATE ═══ */}
        {tab === "simulate" && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-3">
              <div className="bg-white border rounded-xl p-4">
                <div className="text-xs font-bold text-indigo-800 uppercase mb-3">BESS</div>
                <Slider label="Duration" value={bessH} min={1} max={8} step={1} unit="h" onChange={setBessH} />
                <Slider label="Round-trip eff." value={rt} min={0.75} max={0.97} step={0.01} unit="" onChange={setRt} />
                <Slider label="Cycles/day" value={cycD} min={1} max={4} step={1} unit="" onChange={setCycD} />
                <div className="text-xs text-gray-400 mt-1">= {cycD * bessH}h charge + {cycD * bessH}h discharge / day</div>
              </div>
            </div>
            <div className="md:col-span-2 space-y-3">
              {preloadStatus === "done" && (
                <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-xs text-green-700 flex items-center justify-between">
                  <span>✅ <strong>2024 reference year</strong> · {nDays} days · {covPct != null ? covPct + "% curve coverage" : "proxy model"}</span>
                  <button onClick={() => setTab("upload")} className="text-green-600 underline ml-2 shrink-0">change data</button>
                </div>
              )}
              <div className="bg-white border rounded-xl p-4">
                <div className="text-xs font-bold text-indigo-800 uppercase mb-2">Scenarios</div>
                <div className="grid grid-cols-5 gap-2">
                  {SCENARIOS.map(sc => (
                    <div key={sc.label} className="text-center p-2 rounded-lg border" style={{ borderColor: sc.color }}>
                      <div className="font-extrabold text-sm" style={{ color: sc.color }}>{sc.label}</div>
                      <div className="text-xs text-gray-400">{sc.gw === 0 ? "no BESS" : sc.gw * 1000 + " MW / " + sc.gw * bessH * 1000 + " MWh"}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className={"border rounded-xl p-3 text-xs " + (curveStacks ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200")}>
                {curveStacks
                  ? <span className="font-bold text-green-800">Curve model active · {covPct}% days covered</span>
                  : <span className="font-bold text-amber-800">Proxy model · non-linear merit order</span>}
              </div>
              <button onClick={runSim} disabled={running || !hasP}
                className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-xl py-3 font-bold text-sm">
                {running ? (runSt || "Simulating...") : "▶  Run simulation · " + nDays + " days"}
              </button>
            </div>
          </div>
        )}

        {/* ═══ RESULTS ═══ */}
        {tab === "results" && simRes && (
          <div>
            <div className="grid grid-cols-5 gap-2 mb-4">
              {stats.map(sc => (
                <div key={sc.label} className="bg-white rounded-xl p-3 border-t-4 shadow-sm" style={{ borderColor: sc.color }}>
                  <div className="font-extrabold text-sm" style={{ color: sc.color }}>{sc.label}</div>
                  <div className="text-xs text-gray-400 mt-1">Avg max</div>
                  <div className="font-bold">EUR{fmt(sc.avgMax, 1)}</div>
                  <div className="text-xs text-gray-400 mt-1">Avg min</div>
                  <div className="font-bold">EUR{fmt(sc.avgMin, 1)}</div>
                  <div className="text-xs text-gray-400 mt-1">Avg spread</div>
                  <div className="font-bold" style={{ color: sc.color }}>EUR{fmt(sc.avgSpread, 1)}</div>
                  {sc.gw > 0 && <div className="text-xs text-gray-300 mt-1">{sc.curvePct}% curve</div>}
                </div>
              ))}
            </div>
            <div className="flex gap-1 mb-3 flex-wrap">
              {["strip", "shape", "spread", "revenue", "summary"].map(t => (
                <button key={t} onClick={() => setResultTab(t)}
                  className={"px-3 py-1 rounded-full text-xs font-semibold border transition-all " + (resultTab === t ? "bg-indigo-600 text-white" : "bg-white text-gray-500 hover:bg-indigo-50")}>
                  {{ strip: "Strip", shape: "Shape", spread: "Spread", revenue: "Revenue", summary: "Summary" }[t]}
                </button>
              ))}
            </div>
            <div className="bg-white border rounded-xl p-4">

              {resultTab === "strip" && stripData && (() => {
                const { bars, sc, label } = stripData;
                return (
                  <div>
                    <div className="flex gap-2 items-center mb-3 flex-wrap">
                      <span className="text-xs font-medium text-gray-600">{label}</span>
                      <div className="flex gap-1">
                        {SCENARIOS.map(s => (
                          <button key={s.label} onClick={() => setStripSc(s.label)}
                            className="text-xs px-2 py-0.5 rounded-full border font-semibold"
                            style={stripSc === s.label ? { background: s.color, borderColor: s.color, color: "#fff" } : { borderColor: s.color, color: s.color }}>
                            {s.label}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-3 text-xs text-gray-500">
                        {[["charge", "#10b981", "Charge"], ["discharge", "#ef4444", "Discharge"], ["idle", "#e2e8f0", "Idle"]].map(([k, c, l]) => (
                          <span key={k} className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: c }} />{l}</span>
                        ))}
                      </div>
                    </div>
                    <div className="text-xs font-semibold text-gray-600 mb-1">Avg adjusted price (bars) vs base spot (dashed)</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <ComposedChart data={bars} margin={{ top: 4, right: 4, left: 0, bottom: 4 }} barCategoryGap="15%">
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                        <XAxis dataKey="h" tick={{ fontSize: 9 }} interval={0} />
                        <YAxis tick={{ fontSize: 9 }} unit="€" width={38} />
                        <Tooltip formatter={(v, n) => ["EUR" + v, n === "adj" ? "Adjusted" : "Spot"]} contentStyle={{ fontSize: 11 }} />
                        <Bar dataKey="adj" name="adj" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                          {bars.map((d, i) => <Cell key={i} fill={AC[d.act]} />)}
                        </Bar>
                        <Line type="monotone" dataKey="spot" name="spot" stroke="#94a3b8" dot={false} strokeWidth={2} strokeDasharray="5 3" />
                      </ComposedChart>
                    </ResponsiveContainer>
                    <div className="text-xs font-semibold text-gray-600 mt-4 mb-1">State of charge (%)</div>
                    <ResponsiveContainer width="100%" height={80}>
                      <ComposedChart data={bars} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
                        <XAxis dataKey="h" tick={{ fontSize: 9 }} interval={0} />
                        <YAxis tick={{ fontSize: 9 }} unit="%" width={32} domain={[0, 100]} />
                        <Area type="stepAfter" dataKey="soc" fill={sc.color + "33"} stroke={sc.color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      </ComposedChart>
                    </ResponsiveContainer>
                    {sc.gw > 0 && (
                      <div>
                        <div className="text-xs font-semibold text-gray-600 mt-4 mb-1">BESS dispatch (MW) vs market supply</div>
                        <ResponsiveContainer width="100%" height={140}>
                          <ComposedChart data={bars} margin={{ top: 4, right: 4, left: 0, bottom: 12 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                            <XAxis dataKey="h" tick={{ fontSize: 9 }} interval={0} label={{ value: "Hour", position: "insideBottomRight", offset: -4, fontSize: 9 }} />
                            <YAxis tick={{ fontSize: 9 }} width={48} tickFormatter={v => v >= 1000 ? (v / 1000).toFixed(0) + "k" : v} unit="MW" />
                            <Tooltip formatter={(v, n) => [Number(v).toLocaleString() + " MW", n]} contentStyle={{ fontSize: 11 }} />
                            <Legend wrapperStyle={{ fontSize: 10 }} />
                            {bars.some(b => b.mkt) && <Bar dataKey="mkt" name="Market" fill="#e2e8f0" radius={[2, 2, 0, 0]} isAnimationActive={false} />}
                            <Bar dataKey="mw" name="BESS" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                              {bars.map((d, i) => <Cell key={i} fill={AC[d.act]} />)}
                            </Bar>
                          </ComposedChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>
                );
              })()}

              {resultTab === "shape" && shapeData && (
                <div className="space-y-6">
                  <div>
                    <div className="text-xs font-semibold text-gray-600 mb-1">Avg adjusted clearing price by hour</div>
                    <ResponsiveContainer width="100%" height={240}>
                      <LineChart data={shapeData.chrono} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis dataKey="h" tick={{ fontSize: 9 }} interval={0} /><YAxis tick={{ fontSize: 9 }} unit="€" width={38} />
                        <Tooltip formatter={(v, n) => ["EUR" + fmt(v, 1), n]} contentStyle={{ fontSize: 11 }} /><Legend wrapperStyle={{ fontSize: 10 }} />
                        {SCENARIOS.map(sc => (<Line key={sc.label} type="monotone" dataKey={sc.label} stroke={sc.color} strokeWidth={sc.gw === 0 ? 2.5 : 2} strokeDasharray={sc.gw === 0 ? "5 3" : undefined} dot={false} />))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-gray-600 mb-1">Price duration curve</div>
                    <ResponsiveContainer width="100%" height={220}>
                      <LineChart data={shapeData.dur} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis dataKey="pct" tick={{ fontSize: 9 }} unit="%" /><YAxis tick={{ fontSize: 9 }} unit="€" width={38} />
                        <Tooltip formatter={(v, n) => ["EUR" + fmt(v, 1), n]} contentStyle={{ fontSize: 11 }} /><Legend wrapperStyle={{ fontSize: 10 }} />
                        {SCENARIOS.map(sc => (<Line key={sc.label} type="monotone" dataKey={sc.label} stroke={sc.color} strokeWidth={sc.gw === 0 ? 2.5 : 2} strokeDasharray={sc.gw === 0 ? "5 3" : undefined} dot={false} />))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {(resultTab === "spread" || resultTab === "revenue") && (() => {
                const isSpr = resultTab === "spread";
                const mk = isSpr ? "spread" : "rev";
                if (monthlyData.length >= 2) {
                  return (
                    <div>
                      <div className="text-xs text-gray-500 mb-2">{isSpr ? "Avg spread by month" : "Monthly revenue (M EUR)"}</div>
                      <ResponsiveContainer width="100%" height={260}>
                        <LineChart data={monthlyData} margin={{ top: 4, right: 10, left: 0, bottom: 4 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                          <XAxis dataKey="month" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} unit={isSpr ? "€" : "M"} />
                          <Tooltip formatter={(v, n) => [isSpr ? "EUR" + fmt(v, 1) : "EUR" + fmt(v, 2) + "M", n]} /><Legend wrapperStyle={{ fontSize: 10 }} />
                          {(isSpr ? SCENARIOS : SCENARIOS.filter(s => s.gw > 0)).map(sc => (
                            <Line key={sc.label} type="monotone" dataKey={mk + "_" + sc.label} name={sc.label} stroke={sc.color} strokeWidth={sc.gw === 0 ? 1.5 : 2.5} strokeDasharray={sc.gw === 0 ? "4 2" : undefined} dot={false} />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  );
                }
                const barD = stats.filter(s => isSpr || s.gw > 0).map(sc => ({ label: sc.label, color: sc.color, value: +(isSpr ? sc.avgSpread : sc.annRev / 1e6).toFixed(1) }));
                return (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={barD} margin={{ top: 4, right: 10, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 10 }} unit={isSpr ? "€" : "M"} />
                      <Tooltip formatter={(v, _, p) => [isSpr ? "EUR" + fmt(v, 1) : "EUR" + fmt(v, 1) + "M", p.payload.label]} />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]}>{barD.map(d => <Cell key={d.label} fill={d.color} />)}</Bar>
                    </BarChart>
                  </ResponsiveContainer>
                );
              })()}

              {resultTab === "summary" && (
                <table className="w-full text-xs">
                  <thead><tr className="text-gray-400 border-b">
                    {["Scenario", "GW", "Avg max", "Δ", "Avg min", "Δ", "Spread", "Δ", "Annual rev"].map(h => (
                      <th key={h} className="pb-1 text-left pr-3 font-medium">{h}</th>))}</tr></thead>
                  <tbody>
                    {stats.map((sc, i) => (
                      <tr key={sc.label} className="border-b hover:bg-gray-50">
                        <td className="py-1.5 font-bold pr-3" style={{ color: sc.color }}>{sc.label}</td>
                        <td className="pr-3">{sc.gw}</td>
                        <td className="font-mono pr-3">EUR{fmt(sc.avgMax, 1)}</td>
                        <td className={"pr-3 " + (i > 0 ? (sc.avgMax < base.avgMax ? "text-green-600" : "text-red-400") : "text-gray-300")}>
                          {i === 0 ? "--" : fmt((sc.avgMax - base.avgMax) / base.avgMax * 100, 1) + "%"}</td>
                        <td className="font-mono pr-3">EUR{fmt(sc.avgMin, 1)}</td>
                        <td className={"pr-3 " + (i > 0 ? (sc.avgMin > base.avgMin ? "text-amber-500" : "text-green-600") : "text-gray-300")}>
                          {i === 0 ? "--" : (sc.avgMin >= base.avgMin ? "+" : "") + fmt((sc.avgMin - base.avgMin) / Math.max(Math.abs(base.avgMin), 0.01) * 100, 1) + "%"}</td>
                        <td className="font-mono font-bold pr-3" style={{ color: sc.color }}>EUR{fmt(sc.avgSpread, 1)}</td>
                        <td className={"pr-3 " + (i > 0 ? (sc.avgSpread < base.avgSpread ? "text-red-500" : "text-green-600") : "text-gray-300")}>
                          {i === 0 ? "--" : fmt((sc.avgSpread - base.avgSpread) / base.avgSpread * 100, 1) + "%"}</td>
                        <td className={"font-mono " + (sc.annRev > 0 ? "text-green-700" : "text-red-500")}>
                          {sc.gw === 0 ? "--" : fmtE(sc.annRev)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* ═══ P&L ═══ */}
        {tab === "economics" && simRes && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-white border rounded-xl p-4">
                <div className="text-xs font-bold text-indigo-800 uppercase mb-3">Costs</div>
                <Slider label="CAPEX" value={capex} min={100} max={900} step={10} unit="€/kWh" onChange={setCapex} />
                <Slider label="OPEX" value={opex} min={1} max={25} step={1} unit="€/kWh/yr" onChange={setOpex} />
              </div>
              <div className="md:col-span-3 space-y-3">
                <table className="w-full text-xs bg-white border rounded-xl overflow-hidden">
                  <thead><tr className="bg-gray-50 border-b">
                    {["Scenario", "Capacity", "CAPEX", "OPEX/yr", "Revenue/yr", "EBITDA", "Payback"].map(h => (
                      <th key={h} className="p-2 text-left font-semibold text-gray-500">{h}</th>))}</tr></thead>
                  <tbody>
                    {stats.filter(sc => sc.gw > 0).map(sc => {
                      const kWh = sc.gw * 1000 * bessH * 1000;
                      const cx = capex * kWh, ox = opex * kWh;
                      const eb = sc.annRev - ox, pb = eb > 0 ? cx / eb : Infinity;
                      return (
                        <tr key={sc.label} className="border-b hover:bg-gray-50">
                          <td className="p-2 font-bold" style={{ color: sc.color }}>{sc.label}</td>
                          <td className="p-2">{fmt(sc.gw * bessH * 1000)} MWh</td>
                          <td className="p-2">{fmtE(cx)}</td>
                          <td className="p-2">{fmtE(ox)}</td>
                          <td className={"p-2 font-bold " + (sc.annRev >= 0 ? "text-green-700" : "text-red-500")}>{fmtE(sc.annRev)}</td>
                          <td className={"p-2 font-bold " + (eb >= 0 ? "text-blue-700" : "text-red-500")}>{fmtE(eb)}</td>
                          <td className={"p-2 font-bold " + (!isFinite(pb) ? "text-red-500" : pb < 10 ? "text-indigo-700" : "text-orange-500")}>
                            {!isFinite(pb) ? "∞" : fmt(pb, 1) + " yrs"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="bg-white border rounded-xl p-3">
                  <div className="text-xs text-gray-400 mb-2">Annual Revenue vs EBITDA (M EUR)</div>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={stats.filter(sc => sc.gw > 0).map(sc => {
                      const kWh = sc.gw * 1000 * bessH * 1000;
                      return { label: sc.label, rev: +(sc.annRev / 1e6).toFixed(1), ebitda: +((sc.annRev - opex * kWh) / 1e6).toFixed(1) };
                    })} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} unit="M" domain={["auto", "auto"]} />
                      <ReferenceLine y={0} stroke="#94a3b8" strokeWidth={1} />
                      <Tooltip formatter={(v, n) => ["EUR" + fmt(v, 1) + "M", n]} /><Legend wrapperStyle={{ fontSize: 10 }} />
                      <Bar dataKey="rev" name="Revenue" fill="#6366f1" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="ebitda" name="EBITDA" fill="#10b981" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="mt-3 text-xs text-gray-300 text-center">BESS Simulator v21 · OMIE 2024 · Hourly · Non-linear merit order · Pre-loaded</div>
      </div>
    </div>
  );
}
