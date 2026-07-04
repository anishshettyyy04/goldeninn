/* =========================================================
   GOLDEN INN — SHARED DATA STORE
   Firebase Firestore  → site content (rooms, hall, hero, etc.)
   Firebase Storage    → uploaded media files (images & videos)
   Firestore /media    → media metadata catalogue
   localStorage        → instant-paint cache only
   ========================================================= */

const STORE_KEY = "golden_inn_site_data_v2";
const HOTEL_LAT = 12.8385;
const HOTEL_LNG = 77.6770;

/* ── Firebase init (Firestore only — content data) ─────── */
const firebaseConfig = {
  apiKey:            "AIzaSyBBErAtVo9tzEp0O230RGjOfZICM8IWZug",
  authDomain:        "golden-inn.firebaseapp.com",
  projectId:         "golden-inn",
  storageBucket:     "golden-inn.firebasestorage.app",
  messagingSenderId: "824227419924",
  appId:             "1:824227419924:web:60ab53ab53ebdc49429401"
};
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db       = firebase.firestore();
const CONTENT_REF = db.collection("site").doc("content");
const MEDIA_COL   = db.collection("media");

/* ── Cloudinary config (media files — free, no card) ───── */
const CLOUDINARY_CLOUD  = "egokdwtb";
const CLOUDINARY_PRESET = "goldeninn media";
const CLOUDINARY_URL    = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/upload`;

/** Upload a File to Cloudinary, save metadata to Firestore /media.
 *  onProgress(pct) is called with 0–100 during upload. */
async function uploadMediaFile(file, onProgress){
  const type = file.type.startsWith('video') ? 'video' : 'image';
  const fd   = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', CLOUDINARY_PRESET);
  fd.append('folder', 'goldeninn');

  // Upload with XHR so we get progress events
  const data = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/${type}/upload`);
    xhr.upload.onprogress = e => { if(e.lengthComputable && onProgress) onProgress(Math.round(e.loaded/e.total*100)); };
    xhr.onload = () => {
      const res = JSON.parse(xhr.responseText);
      if(xhr.status === 200) resolve(res);
      else reject(new Error(res.error?.message || 'Upload failed'));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(fd);
  });

  const item = {
    name:      file.name,
    url:       data.secure_url,
    publicId:  data.public_id,
    size:      data.bytes || file.size,
    width:     data.width  || null,
    height:    data.height || null,
    format:    data.format || null,
    type,
    added:     Date.now()
  };
  const docRef = await MEDIA_COL.add(item);
  return { ...item, id: docRef.id };
}

/** Load all media metadata from Firestore /media */
async function loadAllMedia(){
  const snap = await MEDIA_COL.orderBy('added','desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Remove media item from Firestore catalogue only.
 *  Cloudinary files can be bulk-removed via the Cloudinary dashboard. */
async function deleteMediaItem(item){
  await MEDIA_COL.doc(item.id).delete();
}

/** Delete all Firestore /media records that are no longer referenced on the site. */
async function deleteUnusedMedia(siteData){
  const used   = collectUsedImageUrls(siteData);
  const all    = await loadAllMedia();
  const unused = all.filter(m => !used.has(m.url));
  await Promise.all(unused.map(m => MEDIA_COL.doc(m.id).delete()));
  return { removedCount: unused.length, freedBytes: unused.reduce((s,m)=>s+(m.size||0),0) };
}

function collectUsedImageUrls(data){
  const urls = new Set();
  if(data.slides) data.slides.forEach(u => urls.add(u));
  ['rooms','hall','places'].forEach(sec => {
    if(data[sec]) data[sec].forEach(c => { if(c.img) urls.add(c.img); });
  });
  return urls;
}
function formatBytes(n){
  if(n<1024) return n+' B';
  if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
  return (n/(1024*1024)).toFixed(2)+' MB';
}

/* ── Site content (Firestore) ──────────────────────────── */
async function loadFromFirestore(){
  try{
    const snap = await CONTENT_REF.get();
    if(snap.exists && snap.data() && Object.keys(snap.data()).length > 0){
      const defaults = JSON.parse(JSON.stringify(DEFAULTS));
      const remote   = snap.data();
      // Shallow merge remote into defaults
      const data = Object.assign(defaults, remote);
      // For array fields: if remote gave us an empty array, restore the default
      // so the site never shows blank sections due to an accidental empty save
      ['slides','rooms','hall','amenities','places','transport','social'].forEach(function(key){
        if(!data[key] || !Array.isArray(data[key]) || data[key].length === 0){
          data[key] = JSON.parse(JSON.stringify(DEFAULTS[key]));
        }
      });
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      return data;
    }
  }catch(e){ console.warn("Firestore load failed, using cache:", e); }
  return null;
}
async function saveToFirestore(data){
  await CONTENT_REF.set(data);
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

/* ── Cache helpers (instant, no network) ───────────────── */
function loadFromCache(){
  const raw = localStorage.getItem(STORE_KEY);
  if(!raw) return JSON.parse(JSON.stringify(DEFAULTS));
  try{ return Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), JSON.parse(raw)); }
  catch(e){ return JSON.parse(JSON.stringify(DEFAULTS)); }
}
function loadData()  { return loadFromCache(); }
function saveData(d) { localStorage.setItem(STORE_KEY, JSON.stringify(d)); }
function resetData() { localStorage.removeItem(STORE_KEY); }

/* ── Distance helpers ──────────────────────────────────── */
function haversineKm(lat1,lon1,lat2,lon2){
  const R=6371, toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
async function geocodePlace(query){
  try{
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q="+encodeURIComponent(query+", Bangalore, Karnataka, India");
    const res = await fetch(url,{headers:{"Accept":"application/json"}});
    const data = await res.json();
    if(!data||!data[0]) return null;
    const lat=parseFloat(data[0].lat), lng=parseFloat(data[0].lon);
    return { lat, lng, distKm: Math.round(haversineKm(HOTEL_LAT,HOTEL_LNG,lat,lng)*10)/10 };
  }catch(e){ return null; }
}
function directionsUrl(lat,lng,fallbackQuery){
  if(lat&&lng) return `https://www.google.com/maps/dir/?api=1&origin=${HOTEL_LAT},${HOTEL_LNG}&destination=${lat},${lng}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${HOTEL_LAT},${HOTEL_LNG}&destination=${encodeURIComponent(fallbackQuery)}`;
}

/* ── SVG Icons ─────────────────────────────────────────── */
const ICONS = {
  wifi:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 8.5a16 16 0 0 1 20 0"/><path d="M5.5 12.5a11 11 0 0 1 13 0"/><path d="M9 16.5a6 6 0 0 1 6 0"/><circle cx="12" cy="20" r="1.1" fill="currentColor" stroke="none"/></svg>`,
  breakfast:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 13h13a3 3 0 0 1 0 6H4z"/><path d="M17 13a3 3 0 0 0 3-3 2 2 0 0 0-2-2 3 3 0 0 0-1 .2"/><path d="M7 13V7M11 13V7M4 7h13"/></svg>`,
  parking:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 17V7h3.2a2.8 2.8 0 0 1 0 5.6H9"/></svg>`,
  accessible:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="4.5" r="1.6"/><path d="M6 21l3.5-9L12 14l2 7M9.5 12l-3 2M14.5 12H8l1.2-3.2c.3-.8 1-1.3 1.9-1.3h3.4"/></svg>`,
  laundry:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="13" r="5"/><circle cx="8" cy="6" r=".6" fill="currentColor" stroke="none"/></svg>`,
  roomservice:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 14h18a8 8 0 0 1-16 0z"/><path d="M12 4a3 3 0 0 1 3 3h-6a3 3 0 0 1 3-3z"/><path d="M2 18h20"/></svg>`,
  party:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 21l13-13"/><path d="M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/><path d="M3 21l3-1 1-3"/></svg>`,
  pub:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 3h10l-1.4 9.5a3 3 0 0 1-3 2.5h-1.2a3 3 0 0 1-3-2.5z"/><path d="M9.5 15v4M14.5 15v4M7 21h10"/></svg>`,
  bus:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M3 11h18"/><circle cx="7.5" cy="19" r="1.2"/><circle cx="16.5" cy="19" r="1.2"/></svg>`,
  taxi:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 16l1.2-5.4A2 2 0 0 1 8.2 9h7.6a2 2 0 0 1 2 1.6L19 16"/><rect x="3.5" y="16" width="17" height="4" rx="1.4"/><circle cx="7.5" cy="20" r="1"/><circle cx="16.5" cy="20" r="1"/></svg>`,
  train:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="3" width="12" height="13" rx="3"/><path d="M6 11h12M9 16l-2 4M15 16l2 4"/><circle cx="9" cy="7.5" r=".5" fill="currentColor"/><circle cx="15" cy="7.5" r=".5" fill="currentColor"/></svg>`,
  plane:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 13l6-1.5L13 4l2 1-3 7.5 5-1 2 1.5-6 3.5-1.5 4-2-1 .5-4-5.5 1z"/></svg>`,
  phone:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 4h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A16 16 0 0 1 3.5 5.6 1.5 1.5 0 0 1 5 4z"/></svg>`,
  mail:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5L12 13l8.5-6.5"/></svg>`,
  pin:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 21s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="9" r="2.4"/></svg>`,
  globe:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/></svg>`,
  bed:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 18v-7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7M3 18v2M21 18v2M3 13h18"/><rect x="5" y="9" width="6" height="3.5" rx="1"/></svg>`,
  star:`<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.7 1.5 6.8L12 17l-6.1 3.5 1.5-6.8L2.2 9l6.9-.7z"/></svg>`,
  instagram:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17" cy="7" r=".8" fill="currentColor" stroke="none"/></svg>`,
  facebook:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 9V7a1.5 1.5 0 0 1 1.5-1.5H17V3h-2.2A4 4 0 0 0 10.8 7v2H8.5v3H10.8v9h3V12H17l.6-3h-3.6z"/></svg>`,
  whatsapp:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 19l1.1-3.3A8 8 0 1 1 9.4 18z"/><path d="M9 9.2c0 3 2.8 5.8 5.8 5.8.6 0 1-.5.8-1l-.6-1.4a.8.8 0 0 0-.9-.4l-1 .3a4.6 4.6 0 0 1-2.6-2.6l.3-1a.8.8 0 0 0-.4-.9L9 7.4c-.5-.2-1 .2-1 .8z"/></svg>`,
  youtube:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="6" width="19" height="12" rx="4"/><path d="M10.5 9.5l5 2.5-5 2.5z" fill="currentColor" stroke="none"/></svg>`,
  twitter:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3l8 9.5L3.5 21h2.2L12.4 14l4.9 7h3.2l-8.4-10L20.5 3h-2.2l-6 6.9L7.2 3z"/></svg>`,
  menu:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
  close:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 5l14 14M19 5L5 19"/></svg>`,
  direction:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z" fill="currentColor" stroke="none"/></svg>`,
  lock:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
  upload:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  trash:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  copy:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  cloud:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M17.5 19H9a5 5 0 1 1 .9-9.9A6.5 6.5 0 1 1 17.5 19z"/></svg>`,
  video:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M22 8l-6 4 6 4V8z"/></svg>`,
};
function icon(name,size=22){ return `<span class="ic-wrap" style="width:${size}px;height:${size}px">${ICONS[name]||ICONS.star}</span>`; }

/* ── Default content ───────────────────────────────────── */
const DEFAULTS = {
  maintenance:false,
  maintenanceMsg:"We're polishing a few things behind the scenes. Golden Inn will be back online shortly — for bookings, please call us directly.",
  heroEyebrow:"Electronic City · Bangalore",
  heroTitle:"Golden Inn",
  heroSub:"A boutique address for rest and celebration — refined rooms, a grand banquet hall and an in-house pub, on Hosur Road, Electronic City.",
  slides:["assets/room1.png","assets/room2.png","assets/room3.png","assets/room4.png","assets/room5.png"],
  rooms:[
    {img:"assets/room6.png",icon:"bed",title:"Single Bed Room",price:"₹1,299",unit:"/ night",desc:"A refined single room with premium bedding, soft ambient lighting and warm wood-and-gold accents — built for the focused solo traveller.",tags:["Free Wi-Fi","Free Breakfast","Air Conditioned"]},
    {img:"assets/room7.png",icon:"bed",title:"Double Bed Room",price:"₹1,899",unit:"/ night",desc:"A spacious double room finished in our signature black-and-gold palette, designed for couples and friends travelling together.",tags:["Free Wi-Fi","Free Breakfast","Air Conditioned","Room Service"]},
    {img:"assets/room8.png",icon:"bed",title:"Deluxe Twin Room",price:"₹2,299",unit:"/ night",desc:"Two separate beds, extra floor space and elevated finishes — our most requested room for relaxed, longer stays.",tags:["Free Wi-Fi","Free Breakfast","Air Conditioned","Laundry"]}
  ],
  hall:[
    {img:"assets/room12.png",icon:"party",title:"Samarambha Party Hall",price:"₹35,000",unit:"/ event",desc:"An elegant banquet space for weddings, milestone birthdays and corporate gatherings, with full décor and catering support on request.",tags:["Capacity 200+","Sound System","Catering Available","Valet Parking"]}
  ],
  amenities:[
    {iconKey:"wifi",title:"Free Wi-Fi"},{iconKey:"breakfast",title:"Free Breakfast"},
    {iconKey:"parking",title:"Free Parking"},{iconKey:"accessible",title:"Accessible"},
    {iconKey:"laundry",title:"Laundry Service"},{iconKey:"roomservice",title:"Room Service"},
    {iconKey:"party",title:"Party Hall"},{iconKey:"pub",title:"In-house Pub"}
  ],
  places:[
    {img:"assets/room9.png",title:"Wonderla Amusement Park",dist:"~12 km away",desc:"One of Bangalore's largest amusement and water parks.",lat:12.8755,lng:77.6066},
    {img:"assets/room10.png",title:"Lalbagh Botanical Garden",dist:"~18 km away",desc:"A 240-acre botanical garden with a glasshouse and a historic rock formation.",lat:12.9507,lng:77.5848},
    {img:"assets/room11.png",title:"Electronic City IT Hub",dist:"Walking distance",desc:"Bangalore's major tech park district.",lat:12.8452,lng:77.6602},
    {img:"assets/room13.png",title:"Bannerghatta National Park",dist:"~15 km away",desc:"A wildlife park with zoo, safari and butterfly enclosure.",lat:12.7999,lng:77.5774}
  ],
  address:"396/48, Hosur Rd, Dadi Reddy Layout, Veer Sandra, Electronic City, Hebbagodi, Karnataka 560100",
  transport:[
    {iconKey:"bus",text:"BMTC city buses run regularly along Hosur Road, with a stop close to the hotel."},
    {iconKey:"taxi",text:"Cabs and autos are readily available — about 5 minutes from Electronic City Toll Gate."},
    {iconKey:"train",text:"Nearest railway stations: Carmelaram and Heelalige, roughly 6–8 km away."},
    {iconKey:"plane",text:"Kempegowda International Airport is approx. 55 km — pre-book a cab for smooth transfers."}
  ],
  phone1:"+91 87468 34131",
  phone2:"+91 96321 38985",
  website:"goldeninnbangalore.com",
  email:"info@goldeninnbangalore.com",
  social:[
    {iconKey:"instagram",label:"Instagram",url:"https://instagram.com/goldeninnbangalore"},
    {iconKey:"facebook",label:"Facebook",url:"https://facebook.com/goldeninnbangalore"},
    {iconKey:"whatsapp",label:"WhatsApp",url:"https://wa.me/918746834131"},
    {iconKey:"youtube",label:"YouTube",url:"https://youtube.com/@goldeninnbangalore"}
  ]
};
