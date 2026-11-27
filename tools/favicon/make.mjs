import {geoOrthographic,geoPath} from 'd3-geo';
import {feature} from 'topojson-client';
import fs from 'node:fs';
import {createRequire} from 'node:module';
// favicon（app/favicon.svg）を作る。使い方：npm run favicon
// 陸地は Natural Earth の 110m（world-atlas）、日本の形は app/countries.json。日本を中心に置いた正射図法で描く
const require=createRequire(import.meta.url);
const root=new URL('../../',import.meta.url).pathname;
const C=JSON.parse(fs.readFileSync(root+'app/countries.json'));
const land=feature(JSON.parse(fs.readFileSync(require.resolve('world-atlas/land-110m.json'))),'land');
const R=27,cx=32,cy=32;
const proj=geoOrthographic().rotate([-135,-28]).translate([cx,cy]).scale(R).clipAngle(90).precision(.5);
// 投影した輪郭を集め、16〜64px では見えない細部を落とす（Douglas–Peucker 法）
function rings(f){const rs=[];let cur=null;geoPath(proj,{moveTo(x,y){cur=[[x,y]];rs.push(cur)},lineTo(x,y){cur.push([x,y])},closePath(){},arc(){}})(f);return rs}
function dp(pts,tol){if(pts.length<3)return pts;const [a,b]=[pts[0],pts[pts.length-1]];let md=0,mi=0;
 for(let i=1;i<pts.length-1;i++){const p=pts[i],dx=b[0]-a[0],dy=b[1]-a[1],L=Math.hypot(dx,dy)||1e-9,d=Math.abs(dy*p[0]-dx*p[1]+b[0]*a[1]-b[1]*a[0])/L;if(d>md){md=d;mi=i}}
 return md>tol?[...dp(pts.slice(0,mi+1),tol).slice(0,-1),...dp(pts.slice(mi),tol)]:[a,b]}
const area=r=>Math.abs(r.reduce((s,p,i)=>{const q=r[(i+1)%r.length];return s+p[0]*q[1]-q[0]*p[1]},0)/2);
const f1=v=>+v.toFixed(1);
const path=(f,tol=.3,min=1)=>rings(f).filter(r=>area(r)>=min).map(r=>{const m=r.length>>1,s=[...dp(r.slice(0,m+1),tol).slice(0,-1),...dp(r.slice(m),tol)];return 'M'+s.map(p=>f1(p[0])+','+f1(p[1])).join('L')+'Z'}).join('');
const jp=path({type:'Feature',geometry:C.find(c=>c.n==='Japan').g},.2,.2);
const [tx,ty]=proj([139.7,35.7]).map(v=>+v.toFixed(1));
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<!-- じかんの地球儀 favicon の元データ。tools/favicon/make.mjs で生成。直すときはスクリプトを直して npm run favicon -->
<defs>
<radialGradient id="sea" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#4f97d6"/><stop offset=".7" stop-color="#235e9e"/><stop offset="1" stop-color="#173f73"/></radialGradient>
<radialGradient id="shine" cx="35%" cy="28%" r="70%"><stop offset="0" stop-color="#fff" stop-opacity=".25"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".2"/></radialGradient>
</defs>
<circle cx="${cx}" cy="${cy}" r="${R+2.5}" fill="#202f55"/>
<circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#sea)"/>
<path fill="#e9dfc4" d="${path(land)}"/>
<path fill="#e5473b" d="${jp}"/>
<circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#shine)"/>
<circle cx="${tx}" cy="${ty}" r="5" fill="#e5473b" stroke="#fff" stroke-width="2.2"/>
</svg>
`;
fs.writeFileSync(root+'app/favicon.svg',svg);console.log(`app/favicon.svg を書き出しました（${svg.length} バイト）`);
