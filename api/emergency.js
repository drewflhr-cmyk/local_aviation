// api/emergency.js  (lives in the "api" folder of your Vercel project, next to proxy.js)
//
// Checks ADS-B data for aircraft squawking 7500 / 7600 / 7700 within RADIUS_MILES of home and sends a
// push notification to ntfy.sh/adsb-emergency. It runs on the server, so it works with every
// page closed. cron-job.org calls it once a minute.
//
// NEW: it tries adsb.lol first and, if that fails, backup sources in order. The reply says which one answered.
//
// Web address to call:  https://local-aviation.vercel.app/api/emergency
// Test notification:    https://local-aviation.vercel.app/api/emergency?test=1

const HOME_LAT = 27.248805;
const HOME_LON = -80.259035;
const RADIUS_MILES = 50;                    // same scan area as the web page
const NM_TO_MILES = 1.15078;                // nautical miles to statute miles

const NTFY_TOPIC = 'adsb-emergency';        // the topic you subscribed to in the ntfy app
const PAGE_URL = 'https://drewflhr-cmyk.github.io/local_aviation/';   // tapping the notification opens this

const CODES = { '7500': 'HIJACK', '7600': 'RADIO FAILURE', '7700': 'EMERGENCY' };
const CONFIRM_CHECKS = 2;                   // the code must be seen on this many checks in a row before alerting
const REARM_MS = 30 * 60 * 1000;            // after an aircraft has been gone this long, a new sighting alerts again

// If EVERY source fails this many checks in a row (checks are 1 minute apart), send one "check is blind" notification.
// Set to 0 to turn this warning off.
const BLIND_AFTER_FAILS = 15;

// Data sources, tried in this order. Each one is a function that builds its web address from the radius in nautical miles.
// (airplanes.live and adsb.fi are free services like adsb.lol; their data layout is similar but not identical,
//  so the code below handles both "ac" and "aircraft" lists.)
const radiusNm = (RADIUS_MILES / NM_TO_MILES).toFixed(1);
const SOURCES = [
  { name: 'adsb.lol',       url: `https://api.adsb.lol/v2/point/${HOME_LAT}/${HOME_LON}/${radiusNm}` },
  { name: 'airplanes.live', url: `https://api.airplanes.live/v2/point/${HOME_LAT}/${HOME_LON}/${radiusNm}` },
  { name: 'adsb.fi',        url: `https://opendata.adsb.fi/api/v2/lat/${HOME_LAT}/lon/${HOME_LON}/dist/${radiusNm}` },
];

// Remembers what we have seen between checks. Vercel keeps this while the function stays "warm";
// if it restarts, the counts start over (worst case: one repeat alert).
// key = "hex:squawk"  ->  { count, notified, lastSeen }
const seen = new Map();
let failStreak = 0;                         // how many checks in a row every source has failed
let blindNotified = false;                  // so the "blind" warning is only sent once per outage

async function sendNtfy(title, body, priority) {
  const r = await fetch('https://ntfy.sh/' + NTFY_TOPIC, {
    method: 'POST',
    headers: {
      Title: title,                         // plain letters only: headers can't hold fancy characters
      Priority: priority || 'urgent',
      Tags: 'rotating_light',
      Click: PAGE_URL,
    },
    body: body,
  });
  return r.ok;
}

// Straight-line distance from home to a spot, in miles
function milesFromHome(lat, lon) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat - HOME_LAT), dLon = toRad(lon - HOME_LON);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(HOME_LAT)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));     // 3958.8 = Earth's radius in miles
}

// Tries each source in order. Returns { source, list } for the first one that answers properly,
// or { source: null, errors } if they all fail.
async function getAircraft() {
  const errors = [];
  for (const s of SOURCES) {
    try {
      const r = await fetch(s.url, {
        headers: { 'User-Agent': 'local-aviation-emergency-check/1.0' },
        signal: AbortSignal.timeout(8000),            // give up on a source after 8 seconds
      });
      if (!r.ok) { errors.push(`${s.name}: HTTP ${r.status}`); continue; }
      const data = await r.json();
      const list = data.ac || data.aircraft;          // the services name the list differently
      if (!Array.isArray(list)) { errors.push(`${s.name}: no aircraft list`); continue; }
      return { source: s.name, list };
    } catch (e) {
      errors.push(`${s.name}: ${String(e)}`);         // connection failed or timed out: try the next one
    }
  }
  return { source: null, errors };
}

export default async (req, res) => {
  // Optional password: if you set a CRON_SECRET environment variable in Vercel, callers must give it
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = (req.query && req.query.key) || (req.headers.authorization || '').replace('Bearer ', '');
    if (given !== secret) return res.status(401).json({ error: 'unauthorized' });
  }

  // ?test=1 just sends a test notification, so you can check that the phone gets it
  if (req.query && req.query.test) {
    const ok = await sendNtfy('Emergency alert TEST', 'This is a test from the Vercel emergency check.');
    return res.status(200).json({ test: true, sent: ok });
  }

  try {
    const result = await getAircraft();

    if (!result.source) {
      // Every source failed. Still answer 200 so cron-job.org doesn't count it as a failure and switch the job off.
      failStreak += 1;
      if (BLIND_AFTER_FAILS > 0 && failStreak >= BLIND_AFTER_FAILS && !blindNotified) {
        const ok = await sendNtfy(
          'Emergency check cannot see aircraft',
          `No ADS-B source has answered for ${failStreak} checks in a row, so 7500/7600/7700 alerts are not working right now.`,
          'default'
        );
        blindNotified = ok;
      }
      return res.status(200).json({ skipped: true, failStreak, errors: result.errors });
    }
    failStreak = 0;                         // a source answered, so the streak (and the one-time warning) start over
    blindNotified = false;

    const thisCheck = new Set();            // keys seen on this check
    const alerts = [];

    for (const a of result.list) {
      const squawk = String(a.squawk || '');
      if (!CODES[squawk]) continue;         // not an emergency code

      const key = (a.hex || '?') + ':' + squawk;
      thisCheck.add(key);
      const entry = seen.get(key) || { count: 0, notified: false, lastSeen: 0 };
      entry.count += 1;
      entry.lastSeen = Date.now();

      if (entry.count >= CONFIRM_CHECKS && !entry.notified) {
        const who = (a.r || (a.flight || '').trim() || a.hex || 'unknown');
        // Use the position when we have it; otherwise fall back to the distance the service gave (nautical miles)
        const miles = (a.lat != null && a.lon != null ? milesFromHome(a.lat, a.lon) : (a.dst || 0) * NM_TO_MILES).toFixed(1);
        const alt = a.alt_baro === 'ground' ? 'on the ground' : (a.alt_baro || a.alt_geom || '?') + ' ft';
        const ok = await sendNtfy(
          `${squawk} ${CODES[squawk]} nearby`,
          `${who} is squawking ${squawk} (${CODES[squawk]}), ${miles} mi away, ${alt}. Open the radar page to look.`
        );
        entry.notified = ok;                // if the send failed, we try again on the next check
        alerts.push({ who, squawk, sent: ok });
      }
      seen.set(key, entry);
    }

    // Forget aircraft that are no longer squawking an emergency code.
    // One that was alerted stays remembered for REARM_MS so a flickering signal can't alert twice.
    for (const [key, entry] of seen) {
      if (thisCheck.has(key)) continue;
      if (!entry.notified || Date.now() - entry.lastSeen > REARM_MS) seen.delete(key);
    }

    return res.status(200).json({ source: result.source, checked: result.list.length, alerts });
  } catch (e) {
    return res.status(200).json({ skipped: true, error: String(e) });
  }
};
