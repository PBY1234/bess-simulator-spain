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
  // Collapse to hourly: average the 4 QH within each hour
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
  // Discharge: shift supply right
  const ss=sup.map(p=>({price:p.price,cumMW:p.cumMW+bessMW}));
  const ed=extendFlat(dem,bessMW);
  const dr=solveIntersection(ss,ed);
  if(dr) bdP=Math.max(0,dr.clearPrice);
  // Charge: shift demand right
  const sd=dem.map(p=>({price:p.price,cumMW:p.cumMW+bessMW}));
  const es=extendFlat(sup,bessMW);
  const cr=solveIntersection(es,sd);
  if(cr) bcP=Math.max(0,cr.clearPrice);
  return{basePrice:br.clearPrice,dischargePrice:bdP,chargePrice:bcP,marketMW:stack.supply.at(-1).cumMW};
}

/* ═══════════════ PROXY MODEL v2 — Quantity-based ═══════════════ */
// Core insight: BESS affects MW quantity, quantity determines marginal plant, plant determines price.
// Instead of price = f(bess), we model: newMW = clearingMW ± bessMW → price = supplyCurve(newMW)
//
// We build a synthetic supply curve per hour from:
// 1. Renewable + nuclear base (flat, ~EUR 0-5)
// 2. Hydro/imports (gentle slope, EUR 5-30)
// 3. CCGT gas (steep, EUR 35-80)
// 4. Peakers/oil (very steep, EUR 80-180)
// 5. Interconnectors (France/Portugal price coupling, ~3 GW cap)
//
// Then we walk the curve to find the new clearing price after shifting by bessMW.

// Residual load p50 by hour (GW) — from 2025 OMIE data
const THERMAL_GAP = {
  1:11.7,2:10.3,3:9.7,4:9.3,5:9.3,6:9.9,7:11.6,8:13.9,9:12.9,10:8.1,
  11:4.9,12:2.4,13:1.3,14:1.7,15:1.4,16:1.3,17:3.4,18:4.5,
  19:7.8,20:12.2,21:16.5,22:17.8,23:16.0,24:13.4
};

// Build a synthetic supply curve for a given hour
// Returns array of {mw (cumulative GW), price (EUR/MWh)} points
function buildProxyCurve(hora, spotPrice) {
  const tgGW = THERMAL_GAP[hora] || 10;
  const damGW = tgGW * 0.56; // 44% bilateral
  const pts = [];

  // Solar profile (GW)
  const solGW = (hora >= 7 && hora <= 20)
    ? 18 * Math.exp(-0.5 * Math.pow((hora - 13.5) / 4, 2)) : 0;
  const winGW = 8 + 2 * Math.sin((hora - 6) * Math.PI / 12);
  const nucGW = 7.1;

  // 1. Nuclear: ~7 GW at EUR 0-3
  for (let gw = 0; gw <= nucGW; gw += 0.5) pts.push({ gw, price: 0.5 + gw * 0.3 });

  // 2. Renewables: solar+wind at EUR -5 to 5 (can go negative)
  const reBase = nucGW;
  const reGW = solGW + winGW;
  for (let dg = 0; dg <= reGW; dg += 0.5) {
    pts.push({ gw: reBase + dg, price: -2 + dg * 0.3 / Math.max(reGW, 1) });
  }

  // 3. Interconnectors: ~3 GW at EUR 10-45 (French/Portuguese marginal)
  const icBase = reBase + reGW;
  const icGW = 3;
  for (let dg = 0; dg <= icGW; dg += 0.3) {
    pts.push({ gw: icBase + dg, price: 10 + dg * 12 });
  }

  // 4. Hydro: ~2 GW at EUR 20-40
  const hyBase = icBase + icGW;
  const hyGW = 2;
  for (let dg = 0; dg <= hyGW; dg += 0.3) {
    pts.push({ gw: hyBase + dg, price: 20 + dg * 10 });
  }

  // 5. CCGT gas: steep section — EUR 40 to spotPrice+20
  const gasBase = hyBase + hyGW;
  const gasGW = Math.max(damGW - icGW - hyGW, 1);
  for (let dg = 0; dg <= gasGW; dg += 0.2) {
    const frac = dg / gasGW;
    // Quadratic: steeper as we approach the top
    pts.push({ gw: gasBase + dg, price: 40 + frac * frac * (Math.max(spotPrice * 1.2, 70) - 40) });
  }

  // 6. Peakers/oil: very steep — EUR spotPrice to 180+
  const pkBase = gasBase + gasGW;
  const pkGW = 2;
  for (let dg = 0; dg <= pkGW; dg += 0.2) {
    pts.push({ gw: pkBase + dg, price: Math.max(spotPrice, 60) + dg * 40 });
  }

  return pts;
}

// Walk the supply curve to find price at a given cumulative GW
function priceAtGW(curve, targetGW) {
  if (targetGW <= curve[0].gw) return curve[0].price;
  if (targetGW >= curve.at(-1).gw) return curve.at(-1).price;
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].gw >= targetGW) {
      // Linear interpolation between points
      const prev = curve[i - 1], curr = curve[i];
      const frac = (targetGW - prev.gw) / (curr.gw - prev.gw);
      return prev.price + frac * (curr.price - prev.price);
    }
  }
  return curve.at(-1).price;
}

// Find approximate clearing GW (where price matches spot)
function findClearingGW(curve, spotPrice) {
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].price >= spotPrice) {
      const prev = curve[i - 1], curr = curve[i];
      if (curr.price === prev.price) return curr.gw;
      const frac = (spotPrice - prev.price) / (curr.price - prev.price);
      return prev.gw + frac * (curr.gw - prev.gw);
    }
  }
  return curve.at(-1).gw;
}

function proxyPrice(spotPrice, bessMW, action, hora, solarScale = 1.0) {
  const curve = buildProxyCurve(hora, spotPrice, solarScale);
  const bessGW = bessMW / 1000;
  const clearGW = findClearingGW(curve, spotPrice);

  if (action === "discharge") {
    const newClearGW = Math.max(0, clearGW - bessGW);
    return Math.max(0, priceAtGW(curve, newClearGW));
  } else {
    const newClearGW = clearGW + bessGW;
    return Math.max(0, priceAtGW(curve, newClearGW));
  }
}

// Integrated revenue: instead of MW * clearingPrice, integrate the area
// under the supply curve from (clearGW - bessGW) to clearGW for discharge.
// This captures that the first MW earns more than the last MW.
function integratedRevenue(spotPrice, bessMW, hora, solarScale = 1.0) {
  const curve = buildProxyCurve(hora, spotPrice, solarScale);
  const bessGW = bessMW / 1000;
  const clearGW = findClearingGW(curve, spotPrice);
  const newClearGW = Math.max(0, clearGW - bessGW);

  // The BESS displaces generation from newClearGW to clearGW
  // Revenue = integral of (spotPrice - supplyCurve(gw)) over that range
  // Simplified: average price across the displaced band × MW
  const steps = 20;
  const stepGW = (clearGW - newClearGW) / steps;
  let totalRev = 0;
  for (let i = 0; i < steps; i++) {
    const gw = newClearGW + (i + 0.5) * stepGW;
    const p = priceAtGW(curve, gw);
    // Revenue per step = stepGW * 1000 MW * p EUR/MWh * 1h
    totalRev += stepGW * 1000 * p;
  }
  return totalRev; // EUR for 1 hour of discharge
}

/* ═══════════════ SCORE ALL HOURS ═══════════════ */
function scoreAllHours(dailySlots, curveStacks, rt, bessMW, solarScale = 1.0) {
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
          disP: proxyPrice(s.price, bessMW, "discharge", s.hora, solarScale),
          chgP: proxyPrice(s.price, bessMW, "charge", s.hora, solarScale),
          mktMW: null };
      }
    }
  }
  return scores;
}

/* ═══════════════ DAILY DISPATCH ═══════════════ */
// Hourly resolution. Duration in hours = number of consecutive charge/discharge hours.
// cycles/day = number of full charge→discharge cycles.
// E.g. 2h duration, 2 cycles = 4h charge + 4h discharge per day.
function simulateDay(date, slots, scores, bessMW, bessH, rt, cyclesDay) {
  const MWh = bessMW * bessH;
  const maxDisHours = Math.round(cyclesDay * bessH); // total discharge hours
  const maxChgHours = maxDisHours; // equal charge hours needed
  const chrono = slots.slice().sort((a, b) => a.hora - b.hora);
  if (!chrono.length) return null;

  // Score each hour
  const hourData = chrono.map(s => {
    const key = date + "|" + s.hora;
    const sc = scores[key];
    return { hora: s.hora, spot: s.price, sc, key };
  }).filter(h => h.sc);

  // Build round-trip pairs: charge hour before discharge hour
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

  const chgSet = new Set(), disSet = new Set(), usedHours = new Set();
  let nPairs = 0;
  for (const p of pairs) {
    if (nPairs >= maxDisHours) break;
    if (usedHours.has(p.ch.hora) || usedHours.has(p.di.hora)) continue;
    chgSet.add(p.ch.hora);
    disSet.add(p.di.hora);
    usedHours.add(p.ch.hora);
    usedHours.add(p.di.hora);
    nPairs++;
  }

  // Fallback: if no profitable pairs, still dispatch greedily
  if (nPairs === 0 && hourData.length >= 2) {
    const chgR2 = hourData.slice().sort((a, b) => a.sc.chgP - b.sc.chgP);
    const disR2 = hourData.slice().sort((a, b) => b.sc.disP - a.sc.disP);
    let nc = 0, nd2 = 0;
    for (const c of chgR2) {
      if (nc >= maxChgHours) break;
      if (usedHours.has(c.hora)) continue;
      chgSet.add(c.hora); usedHours.add(c.hora); nc++;
    }
    for (const d of disR2) {
      if (nd2 >= maxDisHours) break;
      if (usedHours.has(d.hora)) continue;
      if ([...chgSet].some(ch => ch < d.hora)) {
        disSet.add(d.hora); usedHours.add(d.hora); nd2++;
      }
    }
  }

  // Chronological dispatch
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
      rev -= actualMW * h.sc.chgP;
      soc = Math.min(MWh, soc + stored);
      if (h.sc.hasCurve) curves++;
    } else if (disSet.has(h.hora) && soc > 0) {
      const discharged = Math.min(bessMW, soc);
      act = "discharge"; adj = h.sc.disP; mw = discharged;
      rev += discharged * h.sc.disP;
      soc = Math.max(0, soc - discharged);
      if (h.sc.hasCurve) curves++;
    }
    trace.push({ hora: h.hora, spot: +h.spot.toFixed(2), adj: +adj.toFixed(2),
      mw: +mw.toFixed(0), mktMW: h.sc.mktMW, act, curve: h.sc.hasCurve,
      soc: Math.round(100 * soc / MWh) });
  }

  // For spread: use the discharge price at the peak spot hour and
  // charge price at the trough spot hour — these represent the
  // counterfactual market clearing prices with this BESS fleet
  const peakHour = hourData.reduce((best, h) => h.spot > best.spot ? h : best, hourData[0]);
  const troughHour = hourData.reduce((best, h) => h.spot < best.spot ? h : best, hourData[0]);
  const aMax = peakHour.sc.disP;  // what peak price becomes after BESS discharge
  const aMin = troughHour.sc.chgP; // what trough price becomes after BESS charge

  return { date, bMax, bMin, aMax, aMin,
    bSpread: bMax - bMin, aSpread: Math.max(aMax - aMin, 0),
    rev, curvePct: Math.round(100 * curves / Math.max(hourData.length, 1)),
    trace, endSoc: soc };
}

/* ═══════════════ LOAD DEFAULT OMIE DATA ═══════════════ */
async function loadDefaultOMIE() {

  console.log("Loading OMIE dataset...");

  const res = await fetch("/omie_data.json.gz");

  console.log("Fetch status:", res.status);

  const blob = await res.blob();
  const text = await blob.text();

  const data = JSON.parse(text);

  console.log("Loaded rows:", data.length);

  const slots = data.map(r => ({
    date: r.date,
    hora: Number(r.hora),
    price: Number(r.price)
  }));

  return { slots };
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
  const [tab, setTab] = useState("upload");
  const [resultTab, setResultTab] = useState("strip");
  const [priceSlots, setPriceSlots] = useState([]);
  const [priceStatus, setPriceStatus] = useState(null);
  useEffect(() => {

  if (priceSlots.length > 0) return;

  loadDefaultOMIE().then(r => {

    if (r.slots.length > 0) {

      setPriceSlots(r.slots);

      const nd = new Set(r.slots.map(s => s.date)).size;

      setPriceStatus(
        "Loaded default dataset · " +
        r.slots.length +
        " hourly slots · " +
        nd +
        " days"
      );

    }

  });

}, []);


  
  const [curveStacks, setCurveStacks] = useState(null);
  const [curveStatus, setCurveStatus] = useState(null);
  const [bessH, setBessH] = useState(2);
  const [rt, setRt] = useState(0.88);
  const [cycD, setCycD] = useState(2);
  const [capex, setCapex] = useState(250);
  const [opex, setOpex] = useState(8);
  const [solScale, setSolScale] = useState(1.0);
  const [simRes, setSimRes] = useState(null);
  const [running, setRunning] = useState(false);
  const [runSt, setRunSt] = useState("");
  const [stripSc, setStripSc] = useState("1 GW");
  const [curveHour, setCurveHour] = useState(21);
  const [curveSc, setCurveSc] = useState("5 GW");

  const handlePriceFiles = useCallback(async files => {
    const arr = Array.from(files); let all = [], fail = 0;
    for (const f of arr) { try { const t = await f.text(); all = all.concat(parseMarginalPDBC(t).slots); } catch { fail++; } }
    const seen = {}, ded = [];
    for (const s of all) { const k = s.date + "|" + s.hora; if (!seen[k]) { seen[k] = 1; ded.push(s); } }
    setPriceSlots(ded);
    const nd = new Set(ded.map(s => s.date)).size;
    setPriceStatus("OK " + ded.length + " hourly slots, " + nd + " days, " + arr.length + " file(s)" + (fail ? ", " + fail + " failed" : ""));
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
      // Base
      out["Base"] = allDates.map(date => {
        const sl = daily[date]; let mx = -Infinity, mn = Infinity;
        sl.forEach(s => { mx = Math.max(mx, s.price); mn = Math.min(mn, s.price); });
        return { date, bMax: mx, bMin: mn, aMax: mx, aMin: mn, bSpread: mx - mn, aSpread: mx - mn, rev: 0, curvePct: 0, trace: sl.map(s => ({ hora: s.hora, spot: +s.price.toFixed(2), adj: +s.price.toFixed(2), mw: 0, mktMW: null, act: "idle", soc: 0 })) };
      });
      const bess = SCENARIOS.filter(s => s.gw > 0);
      let idx = 0;
      const next = () => {
        if (idx >= bess.length) { setSimRes(out); setTab("results"); setRunning(false); setRunSt(""); return; }
        const sc = bess[idx++]; const mw = sc.gw * 1000;
        setRunSt(sc.label + " — scoring...");
        setTimeout(() => {
          // Iterative dispatch: score → dispatch → check if peak hours changed → re-score
          const MAX_ITER = 3;
          let scores = scoreAllHours(daily, curveStacks, rt, mw, solScale);
          let results = null;

          for (let iter = 0; iter < MAX_ITER; iter++) {
            setRunSt(sc.label + " — iteration " + (iter + 1) + "/" + MAX_ITER);
            results = allDates.map(d => simulateDay(d, daily[d], scores, mw, bessH, rt, cycD)).filter(Boolean);

            if (iter < MAX_ITER - 1) {
              // Check if dispatch changed peak/trough hours
              // Re-score using adjusted prices as new "spot" to capture feedback
              let changed = false;
              const adjByDateHour = {};
              results.forEach(r => {
                r.trace.forEach(t => {
                  if (t.act !== "idle") {
                    adjByDateHour[r.date + "|" + t.hora] = t.adj;
                  }
                });
              });

              // If active hours' adjusted prices differ significantly from spot, re-score
              const keys = Object.keys(adjByDateHour);
              if (keys.length > 0) {
                let totalDrift = 0;
                keys.forEach(k => {
                  const sc2 = scores[k];
                  if (sc2) totalDrift += Math.abs(adjByDateHour[k] - sc2.spot);
                });
                const avgDrift = totalDrift / keys.length;
                if (avgDrift > 3) { // >EUR 3 average price drift → worth re-iterating
                  changed = true;
                  // Re-score with adjusted prices feeding back
                  scores = scoreAllHours(daily, curveStacks, rt, mw, solScale);
                }
              }
              if (!changed) break; // converged
            }
          }

          out[sc.label] = results;
          setTimeout(next, 0);
        }, 0);
      };
      next();
    }, 0);
  }, [daily, curveStacks, bessH, rt, cycD, solScale]);

  const stats = useMemo(() => {
    if (!simRes) return [];
    return SCENARIOS.map(sc => {
      const r = simRes[sc.label] || [], n = r.length || 1;
      let sm = 0, sn = 0, ss = 0, sr = 0, scv = 0;
      let totalDisMWh = 0, totalDisRev = 0, totalChgMWh = 0, totalChgCost = 0;
      r.forEach(d => {
        sm += d.aMax || 0; sn += d.aMin || 0; ss += d.aSpread || 0;
        sr += d.rev || 0; scv += d.curvePct || 0;
        // Compute capture price from dispatch trace
        if (d.trace) {
          d.trace.forEach(t => {
            if (t.act === "discharge" && t.mw > 0) {
              totalDisMWh += t.mw; // 1 hour
              totalDisRev += t.mw * t.adj;
            }
            if (t.act === "charge" && t.mw > 0) {
              totalChgMWh += t.mw;
              totalChgCost += t.mw * t.adj;
            }
          });
        }
      });
      const capturePrice = totalDisMWh > 0 ? totalDisRev / totalDisMWh : 0;
      const chargeCost = totalChgMWh > 0 ? totalChgCost / totalChgMWh : 0;
      const netCapture = capturePrice - chargeCost;
      const revPerMW = sc.gw > 0 ? (sr * 365 / n) / (sc.gw * 1000) : 0; // EUR/MW/yr
      return {
        ...sc, avgMax: sm / n, avgMin: sn / n, avgSpread: ss / n,
        annRev: sr * (365 / n), curvePct: Math.round(scv / n),
        capturePrice: +capturePrice.toFixed(1),
        chargeCost: +chargeCost.toFixed(1),
        netCapture: +netCapture.toFixed(1),
        revPerMW: +revPerMW.toFixed(0),
      };
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

  // Strip: avg across all days for selected scenario
  const stripData = useMemo(() => {
    if (!simRes || !daily) return null;
    const sc = SCENARIOS.find(s => s.label === stripSc) || SCENARIOS[1];
    const allDates = Object.keys(daily).sort();
    const agg = {}; // hora → {spotSum, adjSum, actVotes, socSum, mwSum, mktSum, count}
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

  // Shape: counterfactual clearing price per hour per scenario
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

  const [eqData, setEqData] = useState(null);
  const [eqRunning, setEqRunning] = useState(false);
  const eqPoint = useMemo(() => {
  if (!eqData) return null;

  const pt = eqData.find(d => d.revPerMW < 10000);

  return pt ? pt.gw : null;

}, [eqData]);

  const runEquilibrium = useCallback(() => {
    setEqRunning(true);
    const allDates = Object.keys(daily).sort();
    const dates = allDates.slice(0, 120);
    const steps = Array.from({ length: 21 }, (_, i) => i * 0.5); // 0 to 10 GW
    const results = [];
    let si = 0;

    const nextStep = () => {
      if (si >= steps.length) {
        setEqData(results);
        setEqRunning(false);
        return;
      }
      const gw = steps[si++];
      const mw = gw * 1000;
      setTimeout(() => {
        if (gw === 0) {
          results.push({ gw, revPerMW: 0, totalRev: 0, capturePrice: 0, spread: 0 });
          nextStep();
          return;
        }
        const scores = scoreAllHours(daily, curveStacks, rt, mw, solScale);
        let totalRev = 0, totalDisMWh = 0, totalDisRev = 0, spreadSum = 0, n = 0;
        dates.forEach(d => {
          const sim = simulateDay(d, daily[d], scores, mw, bessH, rt, cycD);
          if (sim) {
            totalRev += sim.rev;
            spreadSum += sim.aSpread;
            n++;
            sim.trace.forEach(t => {
              if (t.act === "discharge" && t.mw > 0) {
                totalDisMWh += t.mw;
                totalDisRev += t.mw * t.adj;
              }
            });
          }
        });
        const annRev = totalRev * (365 / Math.max(n, 1));
        results.push({
          gw,
          revPerMW: mw > 0 ? Math.round(annRev / mw) : 0,
          totalRev: +(annRev / 1e6).toFixed(1),
          capturePrice: totalDisMWh > 0 ? +(totalDisRev / totalDisMWh).toFixed(1) : 0,
          spread: n > 0 ? +(spreadSum / n).toFixed(1) : 0,
        });
        nextStep();
      }, 0);
    };
    nextStep();
  }, [daily, curveStacks, rt, bessH, cycD, solScale]);

  return (
    <div className="bg-gray-50 min-h-screen p-3 font-sans text-sm text-gray-800">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-xl font-bold text-indigo-900 mb-0.5">BESS Market Clearing Simulator</h1>
        <p className="text-gray-400 text-xs mb-3">OMIE · Hourly · Quantity-based merit order · v20</p>

        <div className="flex gap-1 mb-4 flex-wrap">
          {["upload", "simulate", "results", "economics", "equilibrium"].map(t => (
            <button key={t} onClick={() => setTab(t)} disabled={t !== "upload" && !hasP}
              className={"px-3 py-1.5 rounded-full text-xs font-semibold transition-all " + (tab === t ? "bg-indigo-600 text-white shadow" : "bg-white text-gray-500 hover:bg-indigo-50 border") + " disabled:opacity-30"}>
              {{ upload: "Data", simulate: "Simulate", results: "Results", economics: "P&L", equilibrium: "Equilibrium" }[t]}
            </button>
          ))}
        </div>

        {/* ═══ UPLOAD ═══ */}
        {tab === "upload" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-4">
              <div onDrop={onDropP} onDragOver={e => e.preventDefault()} onClick={() => document.getElementById("fp").click()}
                className="border-2 border-dashed border-indigo-300 rounded-xl p-8 text-center cursor-pointer hover:bg-indigo-50 bg-white">
                <div className="text-3xl mb-2">📈</div>
                <div className="font-semibold text-indigo-700">Drop marginalpdbc files</div>
                <div className="text-xs text-gray-400 mt-1">Hourly or 15-min → auto-averaged to hourly</div>
                <input id="fp" type="file" accept=".csv,.txt,.1" className="hidden" multiple onChange={onDropP} />
              </div>
              {priceStatus && <div className="text-xs font-medium text-green-600">{priceStatus}</div>}
              <div onDrop={onDropC} onDragOver={e => e.preventDefault()} onClick={() => document.getElementById("fc").click()}
                className="border-2 border-dashed border-amber-300 rounded-xl p-8 text-center cursor-pointer hover:bg-amber-50 bg-white">
                <div className="text-3xl mb-2">📉</div>
                <div className="font-semibold text-amber-700">Drop curva_pbc files (optional)</div>
                <div className="text-xs text-gray-400 mt-1">Supply/demand curves for full merit order model</div>
                <input id="fc" type="file" accept=".csv,.txt,.1" className="hidden" multiple onChange={onDropC} />
              </div>
              {curveStatus && <div className="text-xs font-medium text-green-600">{curveStatus}{covPct != null && " · " + covPct + "% coverage"}</div>}
            </div>
            <div className="bg-white border rounded-xl p-4 space-y-3">
              <div className="font-semibold text-gray-700 text-xs uppercase">How it works</div>
              <div className="text-xs text-gray-500 space-y-2">
                <p>1. Load marginal price files (hourly OMIE day-ahead prices)</p>
                <p>2. Optionally load curva_pbc files for real supply/demand curves</p>
                <p>3. The simulator computes what happens when BESS fleets of 1-10 GW bid into the market</p>
                <p>4. Discharge adds supply → suppresses peak prices (non-linearly along the merit order)</p>
                <p>5. Charge adds demand → lifts trough prices (mostly during solar hours)</p>
              </div>
              {hasP && (
                <div className="space-y-2 pt-2">
                  <div className="text-xs text-green-600 bg-green-50 rounded p-2 font-medium">{nDays} days loaded · ready to simulate</div>
                  <button onClick={() => setTab("simulate")} className="w-full bg-indigo-600 text-white rounded-lg py-2 text-xs font-semibold hover:bg-indigo-700">Configure & run</button>
                </div>
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
              <div className="bg-white border rounded-xl p-4">
                <div className="text-xs font-bold text-indigo-800 uppercase mb-3">Scenarios</div>
                <Slider label="Solar capacity" value={solScale} min={0.5} max={3.0} step={0.1} unit="×" onChange={setSolScale} />
                <div className="text-xs text-gray-400 mt-1">
                  {solScale === 1 ? "Current (2025)" : solScale < 1 ? "Reduced solar" : "+" + Math.round((solScale - 1) * 100) + "% solar expansion"}
                  {solScale >= 1.5 && " — deeper midday troughs, faster cannibalisation"}
                </div>
              </div>
            </div>
            <div className="md:col-span-2 space-y-3">
              <div className="bg-white border rounded-xl p-4">
                <div className="grid grid-cols-5 gap-2">
                  {SCENARIOS.map(sc => (
                    <div key={sc.label} className="text-center p-2 rounded-lg border" style={{ borderColor: sc.color }}>
                      <div className="font-extrabold text-sm" style={{ color: sc.color }}>{sc.label}</div>
                      <div className="text-xs text-gray-400">{sc.gw === 0 ? "no BESS" : sc.gw * 1000 + " MW / " + sc.gw * bessH * 1000 + " MWh"}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className={"border rounded-xl p-4 text-xs " + (curveStacks ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200")}>
                {curveStacks
                  ? <div className="font-bold text-green-800">Curve model active{covPct != null && " · " + covPct + "% days covered"}</div>
                  : <div><div className="font-bold text-amber-800">Proxy: non-linear merit order</div>
                    <div className="text-amber-600 mt-1">Calibrated OMIE 2025: 1GW→-12%, 5GW→-77%, 10GW→-100% peak reduction</div></div>}
              </div>
              <button onClick={runSim} disabled={running || !hasP}
                className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-xl py-3 font-bold text-sm">
                {running ? (runSt || "Simulating...") : "Run · " + nDays + " days"}
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
                  {sc.gw > 0 && <div className="text-xs text-gray-400 mt-1">Capture</div>}
                  {sc.gw > 0 && <div className="font-bold text-xs">EUR{fmt(sc.capturePrice, 1)}/MWh</div>}
                  {sc.gw > 0 && <div className="text-xs text-gray-300 mt-0.5">{sc.curvePct}% curve</div>}
                </div>
              ))}
            </div>
            <div className="flex gap-1 mb-3 flex-wrap">
              {["strip", "curves", "model", "shape", "spread", "revenue", "summary"].map(t => (
                <button key={t} onClick={() => setResultTab(t)}
                  className={"px-3 py-1 rounded-full text-xs font-semibold border transition-all " + (resultTab === t ? "bg-indigo-600 text-white" : "bg-white text-gray-500 hover:bg-indigo-50")}>
                  {{ strip: "Strip", curves: "Curves", model: "Model", shape: "Shape", spread: "Spread", revenue: "Revenue", summary: "Summary" }[t]}
                </button>
              ))}
            </div>
            <div className="bg-white border rounded-xl p-4">

              {/* STRIP */}
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

              {/* CURVES — supply/demand intersection viewer */}
              {resultTab === "curves" && (() => {
                const sc = SCENARIOS.find(s => s.label === curveSc) || SCENARIOS[3];
                const bessMW = sc.gw * 1000;
                const allDates = Object.keys(daily).sort();
                const bars = (stripData?.bars || []);
                const spotPrice = bars.length
                  ? bars.reduce((a, b) => a + b.spot, 0) / bars.length
                  : 50;

                const hasCurves = curveStacks && allDates.some(d => curveStacks[d]?.[curveHour]);

                // Determine what the BESS actually does at this hour (majority vote from sim)
                let actVotes = { charge: 0, discharge: 0, idle: 0 };
                if (sc.gw > 0 && simRes?.[sc.label]) {
                  simRes[sc.label].forEach(r => {
                    const t = r.trace?.find(t => t.hora === curveHour);
                    if (t) actVotes[t.act]++;
                  });
                }
                const totalVotes = actVotes.charge + actVotes.discharge + actVotes.idle;
                const dominantAct = actVotes.discharge >= actVotes.charge
                  ? (actVotes.discharge > actVotes.idle ? "discharge" : "idle")
                  : (actVotes.charge > actVotes.idle ? "charge" : "idle");
                const chargePct = totalVotes > 0 ? Math.round(100 * actVotes.charge / totalVotes) : 0;
                const dischargePct = totalVotes > 0 ? Math.round(100 * actVotes.discharge / totalVotes) : 0;
                const idlePct = totalVotes > 0 ? Math.round(100 * actVotes.idle / totalVotes) : 100;

                // Build supply curve from proxy model
                const proxyCurve = buildProxyCurve(curveHour, spotPrice);
                const clearGW = findClearingGW(proxyCurve, spotPrice);

                // Convert proxy curve to MW for chart (consistent with curva_pbc scale)
                const supPts = proxyCurve.map(p => ({ mw: Math.round(p.gw * 1000), price: +p.price.toFixed(1) }));
                const supEnd = supPts.at(-1).mw;

                // Demand curve: typical inelastic
                const clearMW = Math.round(clearGW * 1000);
                const demPts = [];
                for (let mw = 0; mw <= supEnd + bessMW + 2000; mw += 300) {
                  const price = mw < clearMW * 0.8 ? 180 - mw * 0.002
                    : mw < clearMW * 1.2 ? spotPrice + (clearMW - mw) * 0.04
                    : Math.max(-10, spotPrice - (mw - clearMW) * 0.08);
                  demPts.push({ mw, price: +Math.max(price, -10).toFixed(1) });
                }

                // Shifted curves for visualisation
                const supShifted = supPts.map(p => ({ mw: p.mw + bessMW, price: p.price }));
                const demShifted = demPts.map(p => ({ mw: p.mw + bessMW, price: p.price }));

                // Find clearing prices using the quantity-based model
                const baseClearPrice = spotPrice;
                const disClearPrice = proxyPrice(spotPrice, bessMW, "discharge", curveHour);
                const chgClearPrice = proxyPrice(spotPrice, bessMW, "charge", curveHour);

                const baseClear = { mw: clearMW, price: baseClearPrice };
                const disClear = { mw: clearMW + bessMW, price: disClearPrice };
                const chgClear = { mw: clearMW + bessMW, price: chgClearPrice };

                const tgGW = THERMAL_GAP[curveHour] || 10;
                const damGW = tgGW * 0.56;

                const showDischarge = dominantAct === "discharge";
                const showCharge = dominantAct === "charge";
                const yMax = Math.min(Math.max(spotPrice * 2.5, 100), 200);
                const xMax = supEnd + bessMW + 2000;
                const clipY = p => Math.max(-10, Math.min(yMax, p));

                const actLabel = dominantAct === "discharge" ? "Discharging" : dominantAct === "charge" ? "Charging" : "Idle";
                const actColor = AC[dominantAct];

                // Compute activity heatmap for all 24 hours
                const hourActivity = Array.from({ length: 24 }, (_, i) => {
                  const h = i + 1;
                  const votes = { charge: 0, discharge: 0, idle: 0, total: 0 };
                  if (sc.gw > 0 && simRes?.[sc.label]) {
                    simRes[sc.label].forEach(r => {
                      const t = r.trace?.find(t => t.hora === h);
                      if (t) { votes[t.act]++; votes.total++; }
                    });
                  }
                  const chgPct = votes.total > 0 ? votes.charge / votes.total : 0;
                  const disPct = votes.total > 0 ? votes.discharge / votes.total : 0;
                  const idlePct = 1 - chgPct - disPct;
                  const dominant = disPct > chgPct ? (disPct > idlePct ? "discharge" : "idle") : (chgPct > idlePct ? "charge" : "idle");
                  const intensity = Math.max(chgPct, disPct); // 0-1 how active
                  return { h, chgPct, disPct, idlePct, dominant, intensity, votes };
                });

                return (
                  <div>
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      <span className="text-xs font-semibold text-gray-600">Scenario:</span>
                      <div className="flex gap-1">
                        {SCENARIOS.filter(s => s.gw > 0).map(s => (
                          <button key={s.label} onClick={() => setCurveSc(s.label)}
                            className="text-xs px-2 py-0.5 rounded-full border font-semibold"
                            style={curveSc === s.label ? { background: s.color, borderColor: s.color, color: "#fff" } : { borderColor: s.color, color: s.color }}>
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Hour selector heatmap */}
                    <div className="mb-4">
                      <div className="text-xs font-semibold text-gray-600 mb-1.5">Select hour — colour shows BESS activity</div>
                      <div className="flex gap-0.5">
                        {hourActivity.map(ha => {
                          const isSelected = ha.h === curveHour;
                          let bg, textCol;
                          if (ha.dominant === "discharge") {
                            bg = `rgba(239,68,68,${0.15 + ha.intensity * 0.7})`; // red
                            textCol = ha.intensity > 0.4 ? "#fff" : "#b91c1c";
                          } else if (ha.dominant === "charge") {
                            bg = `rgba(16,185,129,${0.15 + ha.intensity * 0.7})`; // green
                            textCol = ha.intensity > 0.4 ? "#fff" : "#065f46";
                          } else {
                            bg = "#f1f5f9"; // gray for idle
                            textCol = "#94a3b8";
                          }
                          return (
                            <button key={ha.h} onClick={() => setCurveHour(ha.h)}
                              className="flex-1 py-1.5 rounded text-center transition-all relative"
                              style={{
                                background: isSelected ? "#312e81" : bg,
                                color: isSelected ? "#fff" : textCol,
                                fontSize: 10,
                                fontWeight: isSelected ? 800 : 600,
                                outline: isSelected ? "2px solid #6366f1" : "none",
                                outlineOffset: 1,
                                minWidth: 0,
                              }}>
                              {ha.h}
                            </button>
                          );
                        })}
                      </div>
                      <div className="flex gap-4 mt-1.5 text-xs text-gray-400 justify-center">
                        <span className="flex items-center gap-1"><span className="w-3 h-2.5 rounded-sm inline-block" style={{ background: "rgba(239,68,68,0.6)" }} />Discharge</span>
                        <span className="flex items-center gap-1"><span className="w-3 h-2.5 rounded-sm inline-block" style={{ background: "rgba(16,185,129,0.6)" }} />Charge</span>
                        <span className="flex items-center gap-1"><span className="w-3 h-2.5 rounded-sm inline-block" style={{ background: "#f1f5f9" }} />Idle</span>
                        <span className="text-gray-300">|</span>
                        <span>Darker = more frequent</span>
                      </div>
                    </div>

                    {/* Action indicator */}
                    <div className="flex items-center gap-3 mb-4 p-2 rounded-lg" style={{ background: actColor + "18", borderLeft: "3px solid " + actColor }}>
                      <span className="text-xs font-bold" style={{ color: actColor }}>{actLabel} at H{curveHour}</span>
                      <span className="text-xs text-gray-500">
                        ({dischargePct}% discharge · {chargePct}% charge · {idlePct}% idle across {totalVotes} days)
                      </span>
                    </div>

                    {dominantAct === "idle" && (
                      <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-4 mb-4">
                        <div className="font-semibold text-gray-700 mb-1">BESS is idle at H{curveHour}</div>
                        <div>The {sc.label} fleet does not typically charge or discharge at this hour, so the supply and demand curves are unaffected.
                          The clearing price remains at the base level of EUR{fmt(spotPrice, 1)}.</div>
                        <div className="mt-2 text-gray-400">Try selecting an hour where the BESS is active — e.g. H13-H16 for charging or H20-H23 for discharging.</div>
                      </div>
                    )}

                    {showDischarge && (
                      <div className="mb-6">
                        <div className="text-xs font-semibold text-gray-700 mb-1">
                          Discharge — {sc.label} adds supply → price drops
                        </div>
                        <div className="text-xs text-gray-400 mb-2">
                          H{curveHour} avg spot: EUR{fmt(spotPrice, 1)} · Thermal gap: {fmt(tgGW, 1)} GW (DAM: {fmt(damGW, 1)} GW)
                        </div>
                        <ResponsiveContainer width="100%" height={300}>
                          <LineChart margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                            <XAxis dataKey="mw" type="number" domain={[0, xMax]} tick={{ fontSize: 8 }}
                              tickFormatter={v => v >= 1000 ? (v / 1000).toFixed(0) + "k" : v} label={{ value: "MW", position: "insideBottomRight", fontSize: 9 }} />
                            <YAxis type="number" domain={[-10, yMax]} tick={{ fontSize: 9 }} unit="€" width={36} />
                            <Tooltip formatter={(v, n) => ["EUR" + (+v).toFixed(1), n]} labelFormatter={v => Number(v).toLocaleString() + " MW"} contentStyle={{ fontSize: 11 }} />
                            <Legend wrapperStyle={{ fontSize: 10 }} />
                            <Line data={supPts.map(p => ({ mw: p.mw, price: clipY(p.price) }))} dataKey="price" name="Supply (base)"
                              stroke="#94a3b8" strokeWidth={2} dot={false} type="monotone" />
                            <Line data={supShifted.map(p => ({ mw: p.mw, price: clipY(p.price) }))} dataKey="price" name={"Supply + " + sc.label}
                              stroke={sc.color} strokeWidth={2.5} dot={false} type="monotone" />
                            <Line data={demPts.map(p => ({ mw: p.mw, price: clipY(p.price) }))} dataKey="price" name="Demand"
                              stroke="#6366f1" strokeWidth={2} strokeDasharray="5 3" dot={false} type="monotone" />
                            <ReferenceLine y={baseClear.price} stroke="#94a3b8" strokeDasharray="3 3" strokeWidth={1} />
                            <ReferenceLine y={disClear.price} stroke={sc.color} strokeDasharray="3 3" strokeWidth={1} />
                          </LineChart>
                        </ResponsiveContainer>
                        <div className="flex gap-6 text-xs mt-1">
                          <span className="text-gray-500">Base: <b>EUR{fmt(baseClear.price, 1)}</b> at {(baseClear.mw / 1000).toFixed(1)} GW</span>
                          <span style={{ color: sc.color }}>With {sc.label}: <b>EUR{fmt(disClear.price, 1)}</b>
                            <span className="text-gray-400 ml-1">({fmt((disClear.price - baseClear.price) / Math.max(baseClear.price, 0.1) * 100, 0)}%)</span></span>
                        </div>
                      </div>
                    )}

                    {showCharge && (
                      <div className="mb-6">
                        <div className="text-xs font-semibold text-gray-700 mb-1">
                          Charge — {sc.label} adds demand → price lifts
                        </div>
                        <div className="text-xs text-gray-400 mb-2">
                          H{curveHour} avg spot: EUR{fmt(spotPrice, 1)} · Thermal gap: {fmt(tgGW, 1)} GW (DAM: {fmt(damGW, 1)} GW)
                        </div>
                        <ResponsiveContainer width="100%" height={300}>
                          <LineChart margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                            <XAxis dataKey="mw" type="number" domain={[0, xMax]} tick={{ fontSize: 8 }}
                              tickFormatter={v => v >= 1000 ? (v / 1000).toFixed(0) + "k" : v} label={{ value: "MW", position: "insideBottomRight", fontSize: 9 }} />
                            <YAxis type="number" domain={[-10, yMax]} tick={{ fontSize: 9 }} unit="€" width={36} />
                            <Tooltip formatter={(v, n) => ["EUR" + (+v).toFixed(1), n]} labelFormatter={v => Number(v).toLocaleString() + " MW"} contentStyle={{ fontSize: 11 }} />
                            <Legend wrapperStyle={{ fontSize: 10 }} />
                            <Line data={supPts.map(p => ({ mw: p.mw, price: clipY(p.price) }))} dataKey="price" name="Supply"
                              stroke="#94a3b8" strokeWidth={2} dot={false} type="monotone" />
                            <Line data={demPts.map(p => ({ mw: p.mw, price: clipY(p.price) }))} dataKey="price" name="Demand (base)"
                              stroke="#6366f1" strokeWidth={2} strokeDasharray="5 3" dot={false} type="monotone" />
                            <Line data={demShifted.map(p => ({ mw: p.mw, price: clipY(p.price) }))} dataKey="price" name={"Demand + " + sc.label}
                              stroke={sc.color} strokeWidth={2.5} strokeDasharray="5 3" dot={false} type="monotone" />
                            <ReferenceLine y={baseClear.price} stroke="#94a3b8" strokeDasharray="3 3" strokeWidth={1} />
                            <ReferenceLine y={chgClear.price} stroke={sc.color} strokeDasharray="3 3" strokeWidth={1} />
                          </LineChart>
                        </ResponsiveContainer>
                        <div className="flex gap-6 text-xs mt-1">
                          <span className="text-gray-500">Base: <b>EUR{fmt(baseClear.price, 1)}</b></span>
                          <span style={{ color: sc.color }}>With {sc.label} charging: <b>EUR{fmt(chgClear.price, 1)}</b>
                            <span className="text-gray-400 ml-1">(+{fmt((chgClear.price - baseClear.price) / Math.max(baseClear.price, 0.1) * 100, 0)}%)</span></span>
                        </div>
                      </div>
                    )}

                    {hasCurves && (
                      <div className="mt-4 text-xs text-green-600 bg-green-50 rounded p-2">
                        Real curve data available for some days at H{curveHour}. Charts above use the synthetic proxy for illustration.
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* MODEL — generation stack, residual load, bilateral split */}
              {resultTab === "model" && (() => {
                // Build hourly generation stack from proxy assumptions
                const hours = Array.from({ length: 24 }, (_, i) => i + 1);

                // Solar profile (GW) — peaks ~12-14h
                const solarGW = h => {
                  if (h < 7 || h > 20) return 0;
                  const peak = 18; // ~18 GW peak solar in Spain 2025
                  const center = 13.5;
                  const width = 4;
                  return peak * Math.exp(-0.5 * Math.pow((h - center) / width, 2));
                };

                // Wind profile (GW) — relatively flat, slight overnight bump
                const windGW = h => 8 + 2 * Math.sin((h - 6) * Math.PI / 12);

                // Nuclear (GW) — flat baseload
                const nuclearGW = 7.1;

                // Total demand profile (GW) — from OMIE typical shape
                const demandProfile = {
                  1: 25, 2: 24, 3: 23, 4: 22.5, 5: 22.5, 6: 23, 7: 25, 8: 28,
                  9: 30, 10: 30, 11: 29, 12: 28, 13: 27, 14: 26.5, 15: 26, 16: 26,
                  17: 27, 18: 28, 19: 30, 20: 33, 21: 35, 22: 34, 23: 32, 24: 28
                };

                const stackData = hours.map(h => {
                  const sol = solarGW(h);
                  const win = windGW(h);
                  const nuc = nuclearGW;
                  const dem = demandProfile[h] || 28;
                  const residual = Math.max(0, dem - sol - win - nuc);
                  const tg = THERMAL_GAP[h] || residual;
                  const bilateral = tg * 0.44; // 44% bilateral
                  const dam = tg * 0.56; // 56% DAM

                  return {
                    h: String(h),
                    nuclear: +nuc.toFixed(1),
                    wind: +win.toFixed(1),
                    solar: +sol.toFixed(1),
                    bilateralThermal: +bilateral.toFixed(1),
                    damThermal: +dam.toFixed(1),
                    demand: +dem.toFixed(1),
                    residual: +tg.toFixed(1),
                  };
                });

                // Residual load distribution with BESS impact
                const residualData = hours.map(h => {
                  const tg = THERMAL_GAP[h] || 10;
                  const row = { h: String(h), residual: +tg.toFixed(1) };
                  SCENARIOS.filter(s => s.gw > 0).forEach(sc => {
                    // Check what BESS does at this hour
                    let avgAct = "idle";
                    if (simRes?.[sc.label]) {
                      const votes = { charge: 0, discharge: 0, idle: 0 };
                      simRes[sc.label].forEach(r => {
                        const t = r.trace?.find(t => t.hora === parseInt(h));
                        if (t) votes[t.act]++;
                      });
                      avgAct = votes.discharge > votes.charge ? (votes.discharge > votes.idle ? "discharge" : "idle") : (votes.charge > votes.idle ? "charge" : "idle");
                    }
                    let adj = tg;
                    if (avgAct === "discharge") adj = Math.max(0, tg - sc.gw); // BESS covers part of thermal gap
                    if (avgAct === "charge") adj = tg + sc.gw * 0.3; // charging adds slight load
                    row[sc.label] = +adj.toFixed(1);
                  });
                  return row;
                });

                // DAM merit order waterfall for a typical peak hour (H21)
                const peakTG = THERMAL_GAP[21] || 16.5;
                const peakDAM = peakTG * 0.56;
                const moBands = [
                  { name: "Hydro", gw: 3.0, color: "#60a5fa", price: "EUR5-30" },
                  { name: "Imports", gw: 1.5, color: "#a78bfa", price: "EUR15-40" },
                  { name: "CCGT (efficient)", gw: Math.min(peakDAM * 0.4, 4), color: "#fb923c", price: "EUR40-60" },
                  { name: "CCGT (marginal)", gw: Math.min(peakDAM * 0.3, 3), color: "#f97316", price: "EUR60-90" },
                  { name: "Peakers/Oil", gw: Math.max(peakDAM - 8.5, 0.5), color: "#ef4444", price: "EUR90-150" },
                ];
                let cumGW = 0;
                const moData = moBands.map(b => {
                  const start = cumGW;
                  cumGW += b.gw;
                  return { ...b, start: +start.toFixed(1), end: +cumGW.toFixed(1) };
                });

                return (
                  <div className="space-y-6">
                    {/* Section 1: Generation stack */}
                    <div>
                      <div className="text-sm font-bold text-gray-800 mb-1">Generation Stack — Typical Spanish Day</div>
                      <div className="text-xs text-gray-500 mb-3">How demand is met hour by hour: renewables + nuclear cover the base, thermal fills the residual load</div>
                      <ResponsiveContainer width="100%" height={260}>
                        <ComposedChart data={stackData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }} barCategoryGap="10%">
                          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                          <XAxis dataKey="h" tick={{ fontSize: 9 }} interval={0} />
                          <YAxis tick={{ fontSize: 9 }} unit=" GW" width={40} />
                          <Tooltip formatter={(v, n) => [v + " GW", n]} contentStyle={{ fontSize: 11 }} />
                          <Legend wrapperStyle={{ fontSize: 10 }} />
                          <Bar dataKey="nuclear" name="Nuclear" stackId="gen" fill="#818cf8" isAnimationActive={false} />
                          <Bar dataKey="wind" name="Wind" stackId="gen" fill="#67e8f9" isAnimationActive={false} />
                          <Bar dataKey="solar" name="Solar" stackId="gen" fill="#fbbf24" isAnimationActive={false} />
                          <Bar dataKey="bilateralThermal" name="Thermal (bilateral)" stackId="gen" fill="#fdba74" isAnimationActive={false} />
                          <Bar dataKey="damThermal" name="Thermal (DAM)" stackId="gen" fill="#f87171" isAnimationActive={false} />
                          <Line type="monotone" dataKey="demand" name="Demand" stroke="#1e293b" strokeWidth={2.5} dot={false} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>

                    {/* Section 2: Residual load / thermal gap */}
                    <div>
                      <div className="text-sm font-bold text-gray-800 mb-1">Residual Load (Thermal Gap) by Hour</div>
                      <div className="text-xs text-gray-500 mb-3">
                        Demand minus renewables minus nuclear = thermal gap. This is what BESS displaces when discharging.
                        The dashed lines show the effective thermal gap after BESS dispatch for each scenario.
                      </div>
                      <ResponsiveContainer width="100%" height={220}>
                        <ComposedChart data={residualData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }} barCategoryGap="15%">
                          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                          <XAxis dataKey="h" tick={{ fontSize: 9 }} interval={0} />
                          <YAxis tick={{ fontSize: 9 }} unit=" GW" width={40} />
                          <Tooltip formatter={(v, n) => [v + " GW", n]} contentStyle={{ fontSize: 11 }} />
                          <Legend wrapperStyle={{ fontSize: 10 }} />
                          <Bar dataKey="residual" name="Thermal gap (base)" fill="#fca5a5" radius={[2, 2, 0, 0]} isAnimationActive={false} />
                          {SCENARIOS.filter(s => s.gw > 0).map(sc => (
                            <Line key={sc.label} type="monotone" dataKey={sc.label} name={"With " + sc.label}
                              stroke={sc.color} strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
                          ))}
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>

                    {/* Section 3: DAM merit order at peak */}
                    <div>
                      <div className="text-sm font-bold text-gray-800 mb-1">DAM Thermal Merit Order — Peak Hour (H21)</div>
                      <div className="text-xs text-gray-500 mb-3">
                        After bilateral contracts (44%), the remaining {fmt(peakDAM, 1)} GW thermal gap clears in the day-ahead market.
                        BESS discharge removes GW from the right (expensive) end — walking down the merit order.
                      </div>
                      <div className="flex gap-1 items-end" style={{ height: 160 }}>
                        {moData.map((b, i) => {
                          const maxH = 140;
                          const prices = b.price.match(/\d+/g)?.map(Number) || [50];
                          const avgP = prices.reduce((a, c) => a + c, 0) / prices.length;
                          const barH = Math.max(20, (avgP / 150) * maxH);
                          return (
                            <div key={i} className="flex flex-col items-center" style={{ flex: b.gw }}>
                              <div className="text-xs font-bold mb-0.5" style={{ color: b.color, fontSize: 9 }}>{b.price}</div>
                              <div className="w-full rounded-t" style={{ background: b.color, height: barH, minWidth: 24 }} />
                              <div className="text-xs text-gray-500 mt-1 text-center leading-tight" style={{ fontSize: 8 }}>{b.name}</div>
                              <div className="text-xs font-mono text-gray-400" style={{ fontSize: 8 }}>{b.gw} GW</div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="flex items-center mt-2 ml-1">
                        <div className="text-xs text-gray-400 mr-2">←</div>
                        <div className="flex-1 h-px bg-gray-300" />
                        <div className="text-xs text-gray-400 mx-2">BESS displaces from right →</div>
                      </div>
                    </div>

                    {/* Section 4: Bilateral split explanation */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                        <div className="text-xs font-bold text-amber-800 mb-2">Bilateral Contracts (44%)</div>
                        <div className="text-xs text-amber-700 space-y-1.5">
                          <p>~44% of Spanish electricity is traded via bilateral contracts — long-term PPAs, forward contracts, and OTC deals that never appear in the day-ahead market.</p>
                          <p>This means the DAM only sees ~56% of total generation. A 5 GW BESS isn't competing against 25 GW of total thermal — it's competing against ~14 GW of DAM-visible thermal.</p>
                          <p>This amplifies the BESS price impact: the same GW of BESS displaces a larger fraction of the visible supply curve.</p>
                        </div>
                      </div>
                      <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4">
                        <div className="text-xs font-bold text-indigo-800 mb-2">Price Formation</div>
                        <div className="text-xs text-indigo-700 space-y-1.5">
                          <p>The DAM clearing price is set by the last (most expensive) MW accepted — the "marginal" unit on the supply curve.</p>
                          <p>At peak hours, this is usually a gas CCGT or peaker. These sit on the steep part of the merit order where each GW removed causes a large price drop.</p>
                          <p>At solar hours, the marginal unit is often a renewable or hydro plant on the flat part of the curve — so adding BESS demand barely moves the price.</p>
                          <p>This asymmetry is why BESS crushes peak prices much more than it lifts trough prices.</p>
                        </div>
                      </div>
                    </div>

                    {/* Section 5: Key assumptions */}
                    <div className="bg-gray-50 border rounded-xl p-4">
                      <div className="text-xs font-bold text-gray-700 mb-2">Model Assumptions</div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-gray-600">
                        <div><span className="font-semibold">Nuclear:</span> 7.1 GW flat baseload</div>
                        <div><span className="font-semibold">Solar peak:</span> ~18 GW at H13-14</div>
                        <div><span className="font-semibold">Wind avg:</span> ~8-10 GW</div>
                        <div><span className="font-semibold">Peak demand:</span> ~35 GW at H21</div>
                        <div><span className="font-semibold">Bilateral:</span> 44% of total energy</div>
                        <div><span className="font-semibold">DAM thermal gap:</span> p50 by hour (2025)</div>
                        <div><span className="font-semibold">Merit order:</span> non-linear (convex at top)</div>
                        <div><span className="font-semibold">Calibration:</span> 1GW→-12%, 5GW→-77% peak</div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* SHAPE */}
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

              {/* SPREAD / REVENUE */}
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

              {/* SUMMARY */}
              {resultTab === "summary" && (
                <div className="space-y-4">
                  <table className="w-full text-xs">
                    <thead><tr className="text-gray-400 border-b">
                      {["Scenario", "GW", "Avg max", "Δ", "Avg min", "Δ", "Spread", "Δ", "Annual rev"].map(h => (
                        <th key={h} className="pb-1 text-left pr-3 font-medium">{h}</th>))}
                    </tr></thead>
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
                          <td className={"font-mono " + (sc.annRev > 0 ? "text-green-700" : "text-gray-400")}>
                            {sc.gw === 0 ? "--" : fmtE(sc.annRev)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Capture price table */}
                  <div className="text-sm font-bold text-gray-800 mt-2 mb-1">Capture Price & Cannibalization</div>
                  <div className="text-xs text-gray-500 mb-2">
                    Capture price = avg EUR/MWh earned when discharging. As BESS penetration grows, capture price erodes — the cannibalization effect.
                  </div>
                  <table className="w-full text-xs">
                    <thead><tr className="text-gray-400 border-b">
                      {["Scenario", "Capture price", "Charge cost", "Net capture", "Rev/MW/yr", "Capture Δ vs 1GW"].map(h => (
                        <th key={h} className="pb-1 text-left pr-4 font-medium">{h}</th>))}
                    </tr></thead>
                    <tbody>
                      {stats.filter(sc => sc.gw > 0).map((sc, i) => {
                        const ref = stats.find(s => s.gw === 1);
                        const capDelta = ref && ref.capturePrice > 0 ? ((sc.capturePrice - ref.capturePrice) / ref.capturePrice * 100) : 0;
                        return (
                          <tr key={sc.label} className="border-b hover:bg-gray-50">
                            <td className="py-1.5 font-bold pr-4" style={{ color: sc.color }}>{sc.label}</td>
                            <td className="font-mono pr-4 font-bold">EUR{fmt(sc.capturePrice, 1)}/MWh</td>
                            <td className="font-mono pr-4 text-red-500">EUR{fmt(sc.chargeCost, 1)}/MWh</td>
                            <td className={"font-mono pr-4 font-bold " + (sc.netCapture > 0 ? "text-green-700" : "text-red-500")}>
                              EUR{fmt(sc.netCapture, 1)}/MWh</td>
                            <td className="font-mono pr-4">EUR{fmt(sc.revPerMW, 0)}/MW</td>
                            <td className={"font-mono pr-4 " + (capDelta < -10 ? "text-red-500" : capDelta < 0 ? "text-amber-500" : "text-gray-400")}>
                              {i === 0 ? "ref" : fmt(capDelta, 0) + "%"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
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
                      <th key={h} className="p-2 text-left font-semibold text-gray-500">{h}</th>))}
                  </tr></thead>
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

        {/* ═══ EQUILIBRIUM ═══ */}
        {tab === "equilibrium" && (
          <div className="space-y-4">
            <div className="bg-white border rounded-xl p-4">
              <div className="text-sm font-bold text-gray-800 mb-1">BESS Market Equilibrium Finder</div>
              <div className="text-xs text-gray-500 mb-3">
                Simulates BESS fleets from 0 to 10 GW in 0.5 GW steps. At each level, computes revenue per MW
                to find where arbitrage collapses — the maximum BESS capacity the market can support.
              </div>
              <div className="flex gap-3 items-center mb-3">
                <div className="text-xs text-gray-600">
                  Solar: <b>{solScale}×</b> · Duration: <b>{bessH}h</b> · Cycles: <b>{cycD}/day</b> · RT: <b>{(rt * 100).toFixed(0)}%</b>
                </div>
                <button onClick={runEquilibrium} disabled={eqRunning || !hasP}
                  className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-lg px-4 py-2 text-xs font-bold">
                  {eqRunning ? "Running 21 scenarios..." : "Find equilibrium"}
                </button>
              </div>
              {eqPoint && (
                <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 text-xs">
                  <span className="font-bold text-indigo-800">Estimated equilibrium: ~{eqPoint} GW</span>
                  <span className="text-indigo-600 ml-2">
                    (revenue/MW drops below EUR 5,000/MW/yr — threshold for economic viability)
                  </span>
                </div>
              )}
            </div>

            {eqData && (
              <div className="space-y-4">
                {/* Revenue per MW curve */}
                <div className="bg-white border rounded-xl p-4">
                  <div className="text-xs font-semibold text-gray-700 mb-1">Revenue per MW vs BESS Penetration</div>
                  <div className="text-xs text-gray-400 mb-2">The equilibrium point is where this curve approaches zero</div>
                  <ResponsiveContainer width="100%" height={240}>
                    <ComposedChart data={eqData.filter(d => d.gw > 0)} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="gw" tick={{ fontSize: 10 }} unit=" GW" />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={v => v >= 1000 ? (v / 1000).toFixed(0) + "k" : v} unit=" €/MW" />
                      <Tooltip formatter={(v, n) => ["EUR" + Number(v).toLocaleString() + "/MW/yr", n]} contentStyle={{ fontSize: 11 }} />
                      <ReferenceLine y={5000} stroke="#ef4444" strokeDasharray="4 2" strokeWidth={1} label={{ value: "Viability threshold", fill: "#ef4444", fontSize: 9 }} />
                      <Area type="monotone" dataKey="revPerMW" name="Rev/MW/yr" fill="#6366f140" stroke="#6366f1" strokeWidth={2.5} dot={{ r: 3, fill: "#6366f1" }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                {/* Capture price erosion */}
                <div className="bg-white border rounded-xl p-4">
                  <div className="text-xs font-semibold text-gray-700 mb-1">Capture Price Erosion</div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={eqData.filter(d => d.gw > 0)} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="gw" tick={{ fontSize: 10 }} unit=" GW" />
                      <YAxis tick={{ fontSize: 10 }} unit=" €" />
                      <Tooltip formatter={(v, n) => ["EUR" + v, n]} contentStyle={{ fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      <Line type="monotone" dataKey="capturePrice" name="Capture price (€/MWh)" stroke="#6366f1" strokeWidth={2} dot={{ r: 2 }} />
                      <Line type="monotone" dataKey="spread" name="Avg spread (€/MWh)" stroke="#f59e0b" strokeWidth={2} dot={{ r: 2 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Total revenue curve */}
                <div className="bg-white border rounded-xl p-4">
                  <div className="text-xs font-semibold text-gray-700 mb-1">Total Annual Revenue vs Penetration</div>
                  <div className="text-xs text-gray-400 mb-2">Revenue peaks then declines as cannibalisation exceeds capacity gains</div>
                  <ResponsiveContainer width="100%" height={200}>
                    <ComposedChart data={eqData.filter(d => d.gw > 0)} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="gw" tick={{ fontSize: 10 }} unit=" GW" />
                      <YAxis tick={{ fontSize: 10 }} unit=" M€" />
                      <Tooltip formatter={(v, n) => ["EUR" + v + "M/yr", n]} contentStyle={{ fontSize: 11 }} />
                      <Bar dataKey="totalRev" name="Annual revenue" fill="#10b981" radius={[3, 3, 0, 0]} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                {/* Data table */}
                <div className="bg-white border rounded-xl p-4">
                  <table className="w-full text-xs">
                    <thead><tr className="text-gray-400 border-b">
                      {["GW", "Rev/MW/yr", "Total rev", "Capture", "Spread"].map(h => (
                        <th key={h} className="pb-1 text-left pr-4 font-medium">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {eqData.filter(d => d.gw > 0).map(d => (
                        <tr key={d.gw} className={"border-b hover:bg-gray-50 " + (d.revPerMW < 5000 ? "text-red-400" : "")}>
                          <td className="py-1 font-bold pr-4">{d.gw} GW</td>
                          <td className="font-mono pr-4">EUR{Number(d.revPerMW).toLocaleString()}</td>
                          <td className="font-mono pr-4">EUR{d.totalRev}M</td>
                          <td className="font-mono pr-4">EUR{d.capturePrice}</td>
                          <td className="font-mono pr-4">EUR{d.spread}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-3 text-xs text-gray-300 text-center">BESS Simulator v20 · OMIE · Quantity-based merit order · Capture price · Interconnectors</div>
      </div>
    </div>
  );
}
