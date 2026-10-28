// api/emergency.js  (put this file in the "api" folder of your Vercel project, next to proxy.js)
//
// Checks adsb.lol for aircraft squawking 7500 / 7600 / 7700 within RADIUS_MILES of home and sends a
// push notification to ntfy.sh/adsb-emergency. It runs on the server, so it works with every
// page closed. Something has to call it on a schedule (see the setup notes in the chat).
//
// Web address to call:  https://local-aviation.vercel.app/api/emergency?key=YOUR_SECRET
// Test notification:    https://local-aviation.vercel.app/api/emergency?key=YOUR_SECRET&test=1

const HOME_LAT = 27.248805;
const HOME_LON = -80.259035;
const RADIUS_MILES = 50;                    // same scan area as the web page
const NM_TO_MILES = 1.15078;                // nautical miles to statute miles

const NTFY_TOPIC = 'adsb-emergency';        // the topic you subscribed to in the ntfy app
const PAGE_URL = 'https://drewflhr-cmyk.github.io/local_aviation/';   // tapping the notification opens this (check it is your page's address)

const CODES = { '7500': 'HIJACK', '7600': 'RADIO FAILURE', '7700': 'EMERGENCY' };
const CONFIRM_CHECKS = 2;                   // the code must be seen on this many checks in a row before alerting
const REARM_MS = 30 * 60 * 1000;            // after an aircraft has been gone this long, a new sighting alerts again

// Remembers what we have seen between checks. Vercel keeps this while the function stays "warm";
// if it restarts, the counts start over (worst case: one repeat alert).
// key = "hex:squawk"  ->  { count, notified, lastSeen }
const seen = new Map();

async function sendNtfy(title, body) {
  const r = await fetch('https://ntfy.sh/' + NTFY_TOPIC, {
    method: 'POST',
    headers: {
      Title: title,                         // plain letters only: headers can't hold fancy characters
      Priority: 'urgent',
      Tags: 'rotating_light',
      Click: PAGE_URL,
    },
    body: body,
  });
  return r.ok;
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
    const radiusNm = (RADIUS_MILES / NM_TO_MILES).toFixed(1);
    const url = `https://api.adsb.lol/v2/point/${HOME_LAT}/${HOME_LON}/${radiusNm}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'local-aviation-emergency-check/1.0' } });
    if (!r.ok) return res.status(502).json({ error: 'adsb.lol returned ' + r.status });
    const data = await r.json();

    const thisCheck = new Set();            // keys seen on this check
    const alerts = [];

    for (const a of data.ac || []) {
      const squawk = String(a.squawk || '');
      if (!CODES[squawk]) continue;         // not an emergency code

      const key = (a.hex || '?') + ':' + squawk;
      thisCheck.add(key);
      const entry = seen.get(key) || { count: 0, notified: false, lastSeen: 0 };
      entry.count += 1;
      entry.lastSeen = Date.now();

      if (entry.count >= CONFIRM_CHECKS && !entry.notified) {
        const who = (a.r || (a.flight || '').trim() || a.hex || 'unknown');
        const miles = ((a.dst || 0) * NM_TO_MILES).toFixed(1);
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

    return res.status(200).json({ checked: (data.ac || []).length, alerts });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
