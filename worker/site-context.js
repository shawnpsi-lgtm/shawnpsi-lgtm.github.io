// Hand-written digest of the site, kept small because Groq's free tier only
// allows 8k tokens/minute and this rides on every single message. Edit it when
// a page or the résumé changes — nothing regenerates it.
export const SITE = `
SHAWN SINGH — data + design. San Francisco, CA.
Currently: Data Scientist at C3 AI, while running Visually Represented Studios.
Open to select freelance & consulting work.
Education: USC (Viterbi Engineering / Dornsife College), BS Data Science &
  Cognitive Science, May 2026. Dean's Honor List 5x.
Contact: shawn@visuallyrepresented.co · linkedin.com/in/shawn-singh-72221a203
  · résumé at /files/resume.pdf · Instagram @visuallyrepresented

PROJECTS (each has its own page on this site)

Cloudexa — /project-cloudexa.html · Data Science / Frontend · 2025 · client ESQ
Data Solutions (a Kinective company). Banking-grade dashboard for monitoring ATM
networks, built for BBVA México: 14,500+ ATMs, 30M+ customers. Replaced a fragile
Power BI setup. Surfaces 8 operational metrics in one scannable view — memory
usage by service, hotfixes over time, TLS protocols, ciphers, service status by
server — plus breadcrumbs and instance management the v1 redesign lacked.
Stack: Figma, Vue 3, Vite, Pinia, TypeScript, DevExtreme, pgAdmin, Power BI.
Also built role-based access control, API services, TLS cipher validation.

NGC2 — /project-ngc2.html · U.S. Army Next-Gen Command & Control, with C3 AI.
Turns dense, format-ambiguous military plans and annexes into structured, trusted
mission data. An agnostic extraction pipeline validates tasks across formats and
revisions; SYNCMAT displays them on a live matrix with owners, timing, and diffs
against the last order. Lattice as integration layer, Foundry as cloud data
layer, edge-to-cloud mesh, on-edge LLM. 4th ID and 25th ID are the first
formations, with a scale path across all eleven divisions.

DJai — /project-djai.html · UX / Product Design · 2024 · Figma. Concept app
bringing real DJ control to phones. Addresses three frictions: repetitive
algorithmic discovery, manual playlist upkeep, and no app with true DJing.
Basic mode for AI-curated playback, Advanced mode with EQ knobs, live mixing and
performance pads. Designed around two personas — Irene, 27, a nurse practitioner
who wants effortless mood-based curation, and Marko, 23, a working DJ who wants
his decks in his pocket. Has an interactive prototype.

Emmy Award — /project-emmy.html · 2022, National Academy of Television Arts and
Sciences (NSPA Emmys), category Animation / Graphics / Special Effects. Shawn was
compositor and motion designer; every layer built from scratch.

Visually Represented — /project-visuallyrepresented.html · San Francisco media
company, founded 2019, Shawn is Founder & Creative Director. Photography, video,
brand work, UGC, 3D animation, renders, campaign roll-outs, interface consulting.
Averages 1.1M+ monthly organic views, $40k+ yearly revenue. Selected clients and
shoots: JELEEL!, Midwxst, SSGKobe, 03 Greedo, DC The Don, Jaden Smith,
Yonge-Dundas Square billboard design in Toronto.

BEAT FX — /beatfx/ · a powerful notepad for on-the-go DJs. Mobile-first web app
that clones the Beat FX section of a Pioneer DJM-A9 mixer: load a track on your
phone and play it through live Web Audio effects — Reverb, Echo, Dub (tape-style
echo) and Drum (beat-synced TR-909 rolls) — with Level/Depth and Time knobs,
beat-division arrows, BPM sync and an X-Pad.

Sayclip — /sayclip/ · crate-dig for audio samples by query. Search real web
video captions by what people say, cut the matching timestamp to a WAV, preview
the waveform and drag the file straight into a folder or DAW like Ableton.
Free Mac app (Apple Silicon), downloadable from its card on the site, plus a
web version. Inspired by Yoink.

OTHER EXPERIENCE
Avenues Consulting Group — founding executive board member, Aug 2023–present.
  Founded this 501(c)(3) with 9 students as USC's first pro-bono project-based
  consulting org, focused on tech. Grew to 120+ members; client work has included
  LinkedIn, DoorDash, CodeNinjas, Mountain Dew and PepsiCo.
The Beatport Group — USC production intern, Aug 2024–present. One of only 10
  selected in America. Ran semesterly events for Grammy-winning DJs with London's
  Lab 54; a 28-day artist marketing campaign he conceived hit 1.3M views.
ESQ Data Solutions — BBVA UI/UX intern, Mexico City, June–August 2025 (the
  Cloudexa engagement). Flew weekly between Sacramento and Mexico City.

SHAWNFLUENCE — /shawnfluence.html, a wiki of the same content: about,
education, contact, every job and skills.

SKILLS
Design: Figma, After Effects, Premiere Pro, Photoshop, Illustrator, Blender,
  Lightroom, Ableton, AutoCAD, Autodesk.
Development: Python, JavaScript, TypeScript, Vue 3, HTML/CSS, SQL, Java, C++, R.
Data: Tableau, Power BI, pandas, NumPy, SPSS, KNIME, Orange, ArcGIS/ESRI, Praat,
  Excel, SAS, SAP HANA, Amazon EC2, Apache Hadoop.
`.trim();
