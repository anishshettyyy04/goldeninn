/* =========================================================
   GOLDEN INN — SUPABASE DATA STORE
   ========================================================= */

const STORE_KEY = "golden_inn_site_data_v4"; // Busted cache
const HOTEL_LAT = 12.8385;
const HOTEL_LNG = 77.6770;

/* ── Supabase Init ─────────────────────────────────────── */
// PASTE YOUR SUPABASE CREDENTIALS HERE:
const SUPABASE_URL = "https://YOUR_PROJECT_ID.supabase.co";
const SUPABASE_KEY = "eyJhbG...YOUR_ANON_KEY_HERE...xyz";

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ── Media Storage (Supabase Storage) ──────────────────── */
async function uploadMediaFile(file, onProgress){
  if(onProgress) onProgress(10); // Fake start progress
  const fileExt = file.name.split('.').pop();
  const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
  const filePath = `uploads/${fileName}`;

  const { error: uploadError } = await supabase.storage.from('goldeninn-media').upload(filePath, file);
  if (uploadError) throw new Error(uploadError.message);
  if(onProgress) onProgress(80);

  const { data: publicUrlData } = supabase.storage.from('goldeninn-media').getPublicUrl(filePath);
  
  const item = {
    name: file.name,
    url: publicUrlData.publicUrl,
    size: file.size,
    type: file.type.startsWith('video') ? 'video' : 'image',
    added: Date.now()
  };

  const { data, error } = await supabase.from('media').insert(item).select().single();
  if (error) throw new Error(error.message);
  if(onProgress) onProgress(100);
  return data;
}

async function loadAllMedia(){
  const { data, error } = await supabase.from('media').select('*').order('added', { ascending: false });
  if (error) return [];
  return data;
}

async function deleteMediaItem(item){
  await supabase.from('media').delete().eq('id', item.id);
  // Optional: delete from storage bucket too
  const filePath = item.url.split('goldeninn-media/')[1];
  if(filePath) await supabase.storage.from('goldeninn-media').remove([filePath]);
}

async function deleteUnusedMedia(siteData){
  const used = collectUsedImageUrls(siteData);
  const all = await loadAllMedia();
  const unused = all.filter(m => !used.has(m.url));
  for(let m of unused) await deleteMediaItem(m);
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

/* ── Site content (Supabase Database) ──────────────────── */
async function loadFromFirestore(){
  try{
    const { data: snap, error } = await supabase.from('site_content').select('data').eq('id', 1).single();
    if(snap && snap.data && Object.keys(snap.data).length > 0){
      const defaults = JSON.parse(JSON.stringify(DEFAULTS));
      const remote = snap.data;
      const data = Object.assign(defaults, remote);
      ['slides','rooms','hall','amenities','places','transport','social'].forEach(function(key){
        if(!data[key] || !Array.isArray(data[key])){
          data[key] = JSON.parse(JSON.stringify(DEFAULTS[key]));
        }
      });
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      return data;
    }
  }catch(e){ console.warn("Supabase load failed:", e); }
  return null;
}

async function saveToFirestore(data){
  const { error } = await supabase.from('site_content').upsert({ id: 1, data: data });
  if (error) throw new Error(error.message);
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

function loadFromCache(){
  const raw = localStorage.getItem(STORE_KEY);
  if(!raw) return JSON.parse(JSON.stringify(DEFAULTS));
  try{ return Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), JSON.parse(raw)); }
  catch(e){ return JSON.parse(JSON.stringify(DEFAULTS)); }
}
function loadData()  { return loadFromCache(); }
function saveData(d) { localStorage.setItem(STORE_KEY, JSON.stringify(d)); }

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
  if(lat && lng) return `https://www.google.com/maps/dir/?api=1&origin=$${HOTEL_LAT},${HOTEL_LNG}&destination=${lat},${lng}`;
  return `https://www.google.com/maps/dir/?api=1&origin=$${HOTEL_LAT},${HOTEL_LNG}&destination=${encodeURIComponent(fallbackQuery)}`;
}

/* ── Translation helpers ──────────────────────────────── */
async function loadTranslations(lang){
  try{
    const { data: snap, error } = await supabase.from('translations').select('data').eq('lang', lang).single();
    if(snap && snap.data && Object.keys(snap.data).length > 0){
      return Object.assign({}, DEFAULT_TRANSLATIONS[lang]||DEFAULT_TRANSLATIONS.en, snap.data);
    }
  }catch(e){}
  return JSON.parse(JSON.stringify(DEFAULT_TRANSLATIONS[lang]||DEFAULT_TRANSLATIONS.en));
}
async function saveTranslations(lang, data){
  await supabase.from('translations').upsert({ lang: lang, data: data });
}

const TRANS_KEYS = {
  nav_home:"Nav: Home",nav_rooms:"Nav: Rooms",nav_hall:"Nav: Party Hall",
  nav_amenities:"Nav: Amenities",nav_explore:"Nav: Explore",
  nav_location:"Nav: Location",nav_contact:"Nav: Contact",nav_call:"Nav: Call Now button",
  hero_eyebrow:"Hero: Eyebrow text",hero_subtitle:"Hero: Subtitle paragraph",
  hero_btn_rooms:"Hero: Explore Rooms button",hero_btn_call:"Hero: Call to Book button",
  rooms_kicker:"Rooms: Kicker label",rooms_title_a:"Rooms: Title word 1 (e.g. Our)",
  rooms_title_b:"Rooms: Title word 2 (e.g. Rooms)",rooms_desc:"Rooms: Description",
  hall_kicker:"Hall: Kicker label",hall_title_a:"Hall: Title word 1",
  hall_title_b:"Hall: Title word 2",hall_desc:"Hall: Description",
  amen_kicker:"Amenities: Kicker",amen_title_a:"Amenities: Title word 1",
  amen_title_b:"Amenities: Title word 2",
  explore_kicker:"Explore: Kicker",explore_title_a:"Explore: Title word 1",
  explore_title_b:"Explore: Title word 2",explore_desc:"Explore: Description",
  loc_kicker:"Location: Kicker",loc_title_a:"Location: Title part 1",
  loc_title_b:"Location: Title part 2 (gold)",loc_getting:"Location: Getting Here label",
  contact_kicker:"Contact: Kicker",contact_title_a:"Contact: Title word 1",
  contact_title_b:"Contact: Title word 2 (gold)",
  form_name:"Form: Name placeholder",form_phone:"Form: Phone placeholder",
  form_email:"Form: Email placeholder",form_msg:"Form: Message placeholder",
  form_send:"Form: Send button",
  btn_directions:"Button: Get Directions",btn_call_book:"Button: Call to Book",
  btn_enquire:"Button: Enquire",btn_book_online:"Button: Book Online label",
  scroll_label:"Hero: Scroll cue text",
};

const DEFAULT_TRANSLATIONS = {
  en:{
    nav_home:"Home",nav_rooms:"Rooms",nav_hall:"Party Hall",
    nav_amenities:"Amenities",nav_explore:"Explore",
    nav_location:"Location",nav_contact:"Contact",nav_call:"Call Now",
    hero_eyebrow:"Electronic City · Bangalore",
    hero_subtitle:"A boutique address for rest and celebration — refined rooms, a grand banquet hall and an in-house pub, on Hosur Road, Electronic City.",
    hero_btn_rooms:"Explore Rooms",hero_btn_call:"Call to Book",
    rooms_kicker:"Stay With Us",rooms_title_a:"Our",rooms_title_b:"Rooms",
    rooms_desc:"Considered interiors, restful beds and a complimentary morning breakfast with every stay — choose the room that suits your trip.",
    hall_kicker:"Celebrate With Us",hall_title_a:"Samarambha",hall_title_b:"Party Hall",
    hall_desc:"A grand banquet space for weddings, milestone birthdays and corporate events — fully equipped, centrally located.",
    amen_kicker:"Hotel Details",amen_title_a:"Amenities &",amen_title_b:"Facilities",
    explore_kicker:"Around Golden Inn",explore_title_a:"Explore",explore_title_b:"Bangalore",
    explore_desc:"Staying with us puts you close to some of Bangalore's most loved destinations — ideal for a day trip during your visit.",
    loc_kicker:"Find Us",loc_title_a:"Location &",loc_title_b:"How To Reach",loc_getting:"Getting Here",
    contact_kicker:"Get In Touch",contact_title_a:"Contact",contact_title_b:"Us",
    form_name:"Your Name",form_phone:"Phone Number",form_email:"Email Address",
    form_msg:"Your Message / Booking Query",form_send:"Send Message",
    btn_directions:"Get Directions",btn_call_book:"Call to Book",
    btn_enquire:"Enquire",btn_book_online:"Book Online",scroll_label:"Scroll",
  }
};

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

const DEFAULTS = {
  maintenance:false,
  maintenanceMsg:"We're polishing a few things behind the scenes. Golden Inn will be back online shortly — for bookings, please call us directly.",
  heroEyebrow:"Electronic City · Bangalore",
  heroTitle:"Golden Inn",
  heroSub:"A boutique address for rest and celebration — refined rooms, a grand banquet hall and an in-house pub, on Hosur Road, Electronic City.",
  slides:[],
  rooms:[
    {img:"",icon:"bed",title:"Single Bed Room",price:"₹1,299",unit:"/ night",desc:"A refined single room with premium bedding, soft ambient lighting and warm wood-and-gold accents — built for the focused solo traveller.",tags:["Free Wi-Fi","Free Breakfast","Air Conditioned"]}
  ],
  hall:[],
  amenities:[
    {iconKey:"wifi",title:"Free Wi-Fi"},{iconKey:"breakfast",title:"Free Breakfast"}
  ],
  places:[],
  address:"396/48, Hosur Rd, Dadi Reddy Layout, Veer Sandra, Electronic City, Hebbagodi, Karnataka 560100",
  transport:[],
  phone1:"+91 87468 34131",
  phone2:"+91 96321 38985",
  website:"goldeninnbangalore.com",
  email:"info@goldeninnbangalore.com",
  social:[{iconKey:"instagram",label:"Instagram",url:"https://instagram.com/goldeninnbangalore"}]
};
