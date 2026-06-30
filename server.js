const express = require('express');
const twilio = require('twilio');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public'));

// ── In-memory state (swap for Redis/DB if you scale) ──────────────────────────
const activeCalls = {};      // callSid → { from, status, startTime, conferenceName, listenSid }
const ringGroups  = {};      // conferenceName → [outboundSids]

// ── Config from env ────────────────────────────────────────────────────────────
const ACCOUNT_SID    = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN     = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER  = process.env.TWILIO_NUMBER;          // your Twilio number e.g. +14155552671
const LISTEN_NUMBER  = process.env.LISTEN_NUMBER;          // your personal number to listen in
const BASE_URL       = process.env.BASE_URL;               // e.g. https://your-app.railway.app
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'phantom123';

// Numbers to ring simultaneously (comma-separated in env)
const RING_TARGETS = (process.env.RING_TARGETS || '')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean);

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;

// ── Simple auth middleware for dashboard API ───────────────────────────────────
function authCheck(req, res, next) {
  const pass = req.headers['x-dashboard-pass'] || req.query.pass;
  if (pass !== DASHBOARD_PASS) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1.  INCOMING CALL WEBHOOK  (set this as your Twilio number's Voice URL)
//     POST /incoming
// ─────────────────────────────────────────────────────────────────────────────
app.post('/incoming', (req, res) => {
  const callSid       = req.body.CallSid;
  const callerNumber  = req.body.From;
  const conferenceName = `conf_${callSid}`;

  // Store call info
  activeCalls[callSid] = {
    from:           callerNumber,
    status:         'ringing',
    startTime:      new Date().toISOString(),
    conferenceName,
    answered:       false,
    listenSid:      null,
  };
  ringGroups[conferenceName] = [];

  // Put the caller into a conference (on hold with music until someone answers)
  const twiml = new VoiceResponse();
  const dial  = twiml.dial();
  dial.conference(conferenceName, {
    startConferenceOnEnter: true,
    endConferenceOnExit:    true,
    waitUrl:                'https://twimlets.com/holdmusic?Bucket=com.twilio.music.ambient',
    waitMethod:             'GET',
    muted:                  false,
  });

  res.type('text/xml').send(twiml.toString());

  // Simultaneously ring all targets
  if (RING_TARGETS.length === 0) {
    console.warn('No RING_TARGETS configured!');
    return;
  }

  RING_TARGETS.forEach(number => {
    client.calls.create({
      to:    number,
      from:  TWILIO_NUMBER,
      url:   `${BASE_URL}/outbound-answer?conf=${encodeURIComponent(conferenceName)}&parentSid=${callSid}`,
      statusCallback: `${BASE_URL}/outbound-status?conf=${encodeURIComponent(conferenceName)}&parentSid=${callSid}`,
      statusCallbackEvent: ['initiated','ringing','answered','completed'],
    })
    .then(call => {
      ringGroups[conferenceName].push(call.sid);
      console.log(`Ringing ${number} → ${call.sid}`);
    })
    .catch(err => console.error(`Failed to ring ${number}:`, err.message));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.  OUTBOUND ANSWER WEBHOOK
//     When one of the ring targets picks up
// ─────────────────────────────────────────────────────────────────────────────
app.post('/outbound-answer', (req, res) => {
  const confName  = req.query.conf;
  const parentSid = req.query.parentSid;
  const callSid   = req.body.CallSid;

  const call = activeCalls[parentSid];

  // If already answered by someone else → reject this leg
  if (call && call.answered) {
    const twiml = new VoiceResponse();
    twiml.say('This call has already been answered. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Mark as answered
  if (call) {
    call.answered  = true;
    call.status    = 'active';
    call.answeredBy = callSid;
  }

  // Hang up all other outbound legs
  const siblings = (ringGroups[confName] || []).filter(sid => sid !== callSid);
  siblings.forEach(sid => {
    client.calls(sid).update({ status: 'completed' })
      .catch(err => console.error(`Could not cancel ${sid}:`, err.message));
  });

  // Join conference
  const twiml = new VoiceResponse();
  const dial  = twiml.dial();
  dial.conference(confName, {
    startConferenceOnEnter: false,
    endConferenceOnExit:    true,
    muted:                  false,
  });

  res.type('text/xml').send(twiml.toString());
});

// ─────────────────────────────────────────────────────────────────────────────
// 3.  OUTBOUND STATUS CALLBACK
// ─────────────────────────────────────────────────────────────────────────────
app.post('/outbound-status', (req, res) => {
  const parentSid = req.query.parentSid;
  const status    = req.body.CallStatus;
  const call      = activeCalls[parentSid];
  if (call && status === 'completed' && !call.answered) {
    // check if all legs failed
    // (handled by conference endConferenceOnExit if no one answers)
  }
  res.sendStatus(200);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4.  LISTEN-IN  (barge into a live conference as muted listener)
//     POST /listen  { conferenceName }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/listen', authCheck, async (req, res) => {
  const { conferenceName } = req.body;
  if (!LISTEN_NUMBER) return res.status(400).json({ error: 'LISTEN_NUMBER not set' });

  try {
    const call = await client.calls.create({
      to:   LISTEN_NUMBER,
      from: TWILIO_NUMBER,
      url:  `${BASE_URL}/listen-join?conf=${encodeURIComponent(conferenceName)}`,
    });
    res.json({ success: true, sid: call.sid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TwiML for the listen-in call leg (joins muted)
app.post('/listen-join', (req, res) => {
  const confName = req.query.conf;
  const twiml    = new VoiceResponse();
  const dial     = twiml.dial();
  dial.conference(confName, {
    startConferenceOnEnter: false,
    endConferenceOnExit:    false,
    muted:                  true,   // silent listener
    beep:                   false,
  });
  res.type('text/xml').send(twiml.toString());
});

// ─────────────────────────────────────────────────────────────────────────────
// 5.  DASHBOARD API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/calls', authCheck, (req, res) => {
  res.json(Object.entries(activeCalls).map(([sid, c]) => ({ sid, ...c })));
});

app.get('/api/config', authCheck, (req, res) => {
  res.json({
    twilioNumber: TWILIO_NUMBER,
    ringTargets:  RING_TARGETS,
    listenNumber: LISTEN_NUMBER ? '***masked***' : null,
  });
});

app.post('/api/hangup', authCheck, async (req, res) => {
  const { conferenceName } = req.body;
  try {
    // End the conference by removing all participants
    const participants = await client.conferences(conferenceName).participants.list();
    await Promise.all(participants.map(p =>
      client.conferences(conferenceName).participants(p.callSid).remove()
    ));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6.  SERVE DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PhantomDial running on port ${PORT}`));
