# MarsWalk — final 30-second video plan (v6, aligned to the official Judging & Submission guides)

**Merges:** Dana's *Bloque 3 v4* (structure that follows the official Space Apps guide, narration, sound, credits, rules)
+ Eric's plan (the safe zone, the options card, the validation number, the real demo presets).
**Everything in scenes 4–7 comes from the real app.** If it doesn't show on screen in the app, it doesn't go in the video.

---

## 0. Decisions taken in this version (and why)

| # | Decision | Why |
|---|---|---|
| 1 | **Product name = MarsWalk.** "Martian Map" is the *challenge* name | The app, the repo, the URL (`/marswalk/`) and the README all say MarsWalk. Using the challenge name as the product name makes judges think it's the challenge title. The page, the video and the app must use the same name. |
| 2 | Tagline stays **"Plan the walk. Come home."** (Dana's) | It is the one rule of the planner said in 5 words. |
| 3 | The climax is the real **`leak-cache` preset**, not a leak staged at Wildcat Ridge | It is reproducible with one URL and already tested end to end: habitat ✗ → Cache 1 ✓ → refill 120 → home. Dana's point #9 is right: an ordinary leak at Wildcat on EVA-1 does not make home unreachable, so we don't fake it. The preset starts with the tank at 50% and says so. |
| 4 | Add the **live safe zone** (red / amber) to scenes 4 and 7 | It is the visual nobody else will have: the region from which the crew can still get home shrinks as O₂ is spent. It *is* "Come home" turned into a picture. |
| 5 | Add the **options card** to scene 7 (Habitat ✗ not enough O₂ · Cache 1 ✓) | It shows that MarsWalk *reasons and explains*, which is the Creativity and Validity argument. |
| 6 | Scene 5 uses the **real validation figure** (sols 538→543), not the EVA-1 route over the traverse | The 99.7% number belongs to that drive. Same words as Dana: "checked against", never "validated" or "proven". |
| 7 | Scene 6 shows the **POV card of the tablet** (ph-wr-01 = PIA24928) | It's the photo the app really shows at Wildcat Ridge. PIA25246 (abrasion patch) only if it's added to `photos.json` first. |
| 9 | **v6:** scenes snapped to the official seconds (0:00 / 0:02 / 0:05 / 0:10 / 0:20–0:30), Space Agency Partner data (Mars Climate Database, ESA/CNES) named on screen, Impact line now says "Mars and the Moon" | The guide asks for exactly these blocks and for NASA **and partner** data in the 0:10 block; Impact scores reach |
| 8 | Plan B1 (SPE → pressurized rover) **is no longer needed** but is recorded as backup | Both are verified: `test/jezero_eva.mjs` checks SPE at Wildcat → `shelter-sev-rover-01` and leak → cache rescue, and exits with an error if either breaks. |

**Dana's open items, resolved:**
- Team name: **CheeriOS**.
- DTM source: **USGS Astrogeology / NASA, Mars 2020 TRN HiRISE DTM mosaic of Jezero** (`JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m`).
- Leak → `resupply` with `stations.geojson`: works (preset `leak-cache`).
- SPE → `shelter-sev-rover-01`: yes.
- HUD uses the 18% reserve (393.6 usable min): yes.

---

## 1. What the judges score, and where we win each point

Each judge gives **1–5 on five criteria of equal weight**. **Presentation is scored on the demo AND the full project**
(project page, app, repo), so the video and the page have to tell the same story.

| Criterion | What a 5 needs (official guide) | Where we show it | Words judges must see/hear |
|---|---|---|---|
| **Impact** | Significant problem; extensive reach; "could change the world" | Scene 2 (first human walk on Mars) + scene 8 (Mars, the Moon, Earth analog crews) | "the first Marswalk" · "Mars · the Moon · Earth analog sites" |
| **Creativity** | Never attempted before; challenges conventional methods | Scenes 4 + 7: the **live safe zone** and the **options card** (the planner *reasons* and explains, re-plans in < 1 s) | "Rerouted in under a second" |
| **Validity** | Scientifically sound, technically feasible, **fully developed, usable and user-friendly** | Scene 5 (checked against Perseverance) + scenes 6–7 are the **real working app**, two screens, one click | "99.7% of the rover's track within 20 m" |
| **Relevance** | Fully addresses the challenge; **NASA data integral, not superficial** | Scene 4 chips show which NASA dataset drives each layer; scene 6 real rover photo | "HiRISE DTM · USGS/NASA" · "Real Perseverance photo" |
| **Presentation** | Clear challenge → solution → significance; engaging, polished | Official structure second by second (section 2), one idea per scene, the tagline at the start and end | "Plan the walk. Come home." |

**Story in one line:** *On Mars, getting there is only half the walk: MarsWalk turns NASA data into routes that always keep the way home, and finds a new one when something goes wrong.*

---

## 2. Master storyboard: follows the official timing exactly

Official guide timing: `[0:00] name + team` → `[0:02] challenge + inspiration` → `[0:05] title + tagline` →
`[0:10] how it works, images/prototype, user experience, NASA + Space Agency Partner data` → `[0:20–0:30] the future`.

Columns: what you see · what's happening (action in the app) · what's said (EN narration = burned-in subtitles) · on-screen text · audio.

| # | Time | Guide block | What you see | What's happening | Narration (EN) | On-screen text | Audio |
|---|---|---|---|---|---|---|---|
| 1 | 0:00–0:02 | Name + team | **ph-tf-11** (Navcam sol 658: plain with rover tracks), push-in ≤ 8% | Presenter intro | "I'm Dana, with team CheeriOS." | **Team CheeriOS** · Dana · Eric · Santiago · Gabriel · Ana · Marco · *NASA Space Apps Saltillo, Mexico* | Real Mars wind + low pad |
| 2 | 0:02–0:05.5 | Challenge + inspiration | **S70-29540** (Apollo in El Pinacate, 1970) → 12-frame crossfade → **ph-hab-01** (habitat site, Jezero) | Why this challenge | "Apollo trained in Sonora. Our challenge: the first Marswalk." | Top: *Challenge: Interplanetary Survival Guide — Martian Map* · bottom: *Pinacate, Sonora · 1970 → Jezero Crater, Mars* | Synth pulse comes in |
| 3 | 0:05.5–0:10 | Title + tagline | Console hillshade (3 × 3 km) with the targets as pins coming in one by one | Name + promise | "MarsWalk. *(pause)* Plan the walk. Come home." | **MARSWALK** / *Plan the walk. Come home.* / *EVA routes computed from NASA data* | Music hit on the title |
| 4 | 0:10–0:13 | How it works + data | **Real capture, console** (`?demo=eva1-nominal`): slope → hazard → line of sight (0.5 s each) → route draws itself with the **safe zone** (red) and the **GO** badge | NASA data → oxygen cost → route | "NASA terrain sets the oxygen cost of every step." | Left chips (cyan): *HiRISE DTM · USGS/NASA* → *Slope · Hazard · Line of sight* → *O₂ minutes per 3 m cell* → *Sunset & weather: Mars Climate Database (ESA/CNES)* | Soft UI clicks |
| 5 | 0:13–0:15 | How it works (proof) | Validation figure `docs/validation/validation_test2_route_map.png`, panel for sols 538→543 | Science credibility | "Checked against Perseverance's real path." | Top band: **99.7% of the rover's track within 20 m of our route** (open plain) · small: *NASA/JPL MMGIS* | Stronger pulse |
| 6 | 0:15–0:16 | User experience | **Real capture, tablet:** astronaut HUD + POV card at Wildcat Ridge (ph-wr-01 = PIA24928) | What the astronaut sees | — (no voice) | *Astronaut tablet · real Perseverance photo of the next stop* · credit *NASA/JPL-Caltech/ASU/MSSS* | Telemetry beep |
| 7 | 0:16–0:20 | User experience (crisis) | **Key shot, split console + tablet** (`?demo=leak-cache`): 2-frame red flash → alarm → **red zone closes in** → card **Habitat ✗ not enough O₂ · Cache 1 ✓** → new route → **refill +120** → home | Planner reasons and re-plans | "Oxygen leak? It reroutes to a cache, then home." | **ALERT: O₂ leak** (red) → **Rerouted in under a second** (amber) · next to the cache: *O₂ cache (mission concept)* | Two-tone 0.5 s alarm · music drops (0.6 s of drone) and comes back with the route |
| 8 | 0:20–0:30 | The future | Zoom out from the full route over Jezero (3 s) → S70-29540 again, warm tone (3 s) → end card (4 s) | Impact on people, the world and beyond | "Tomorrow, it could guide the first walks on Mars and the Moon. Today, crews training in deserts like Pinacate. Every walk, planned to come home." | *Mars · the Moon · Earth analog crews* → **MarsWalk — Plan the walk. Come home.** · *Built on open NASA data* · `cheeriosspaceapp.github.io/marswalk` · credits strip | Music builds and resolves · 1 s of wind |

**Narration:** 68 words, ~27 s of voice (scene 8 is the densest: 25 words in 9.5 s; if the voice rushes there, use cut 1). Calm mission-controller tone, short pause before "Come home". Pronunciation: Jezero *JEZ-eh-roh*, Pinacate *pee-nah-KAH-teh*.

**If the voice runs over 27.5 s,** cut in this order and measure after each cut:
1. Line 8 → "Tomorrow, the first walks on Mars and the Moon. Every walk, planned to come home."
2. Line 2 → "Our challenge: the first Marswalk." (Apollo stays as on-screen text.)

Never cut 1, 3, 4, 5, 7: they carry the name, the title, the NASA data, the validation and the creative core.

**TTS (only if no team voice):**
```
<speak>I'm Dana, with team CheeriOS. <break time="250ms"/>
Apollo trained in Sonora. <break time="150ms"/> Our challenge: the first Marswalk. <break time="400ms"/>
MarsWalk. <break time="300ms"/> Plan the walk. <break time="300ms"/> Come home. <break time="400ms"/>
NASA terrain sets the oxygen cost of every step. <break time="200ms"/>
Checked against Perseverance's real path. <break time="1000ms"/>
Oxygen leak? <break time="300ms"/> It reroutes to a cache, then home. <break time="400ms"/>
Tomorrow, it could guide the first walks on Mars and the Moon. <break time="300ms"/> Today, crews training in deserts like
<phoneme alphabet="ipa" ph="pinaˈkate">Pinacate</phoneme>. <break time="300ms"/> Every walk, planned to come home.</speak>
```
With TTS: the label **"AI-generated voice"** stays on screen the whole video (top right, 18 px), and goes in the YouTube description and the AI field.

---

## 3. Checklist against the official demo rules

| Official requirement | How we meet it |
|---|---|
| Video **30 s or less** (more = not eligible) | Final cut **≤ 29.5 s**, measured on YouTube, not in the editor |
| Shows the **final project, including the software** | Scenes 4, 6, 7 are unedited captures of the deployed app |
| **English subtitles** (mandatory if anyone speaks another language; we use them anyway) | Narration burned in as subtitles |
| **Public link** on an external host (YouTube / Drive) | YouTube *Unlisted* or *Public*; tested in incognito and on a phone without a login |
| [0:00] name + team · [0:02] challenge + inspiration · [0:05] title + tagline · [0:10] how it works + user experience + **NASA and Space Agency Partner data** · [0:20–0:30] future | Scenes 1 · 2 · 3 · 4–7 (scene 4 names the NASA DTM and the ESA/CNES Mars Climate Database) · 8 |
| Strong visuals, readable for someone with no context | One idea per scene, text ≥ 32 px, subtitles 44 px, no jargon in the narration |
| No copyrighted material without permission | Royalty-free music with a saved license screenshot (or none); NASA images credited; no NASA logos |

## 4. Takes to record (Santiago): 1920 × 1080, 60 fps, incognito, browser zoom 100%, no bookmarks bar or notifications

Base URL: `https://cheeriosspaceapp.github.io/marswalk/` (or `npm run dev` → `http://localhost:5173/`).
Open the **console and the tablet side by side in the same browser** (a hidden window gets paused).

| Take | URL / action | Duration to record | Scene |
|---|---|---|---|
| A | `console.html?site=jezero` → turn on Slope, Hazard, No comms (1 s each) | 6 s | 4 |
| B | `console.html?site=jezero&demo=eva1-nominal` + `tablet.html?site=jezero&demo=1` → the route draws itself, **GO** badge, red zone | 8 s | 3–4 |
| C | Tablet arriving at Wildcat Ridge → HUD + POV card ph-wr-01 (with the `eva1-nominal` preset; speed it up with the tablet's speed button) | 5 s | 6 |
| D (**key**) | `console.html?site=jezero&demo=leak-cache` + `tablet.html?site=jezero&demo=1`. **Record without cutting** from the end of the survey task until the habitat ingress (~2 min real): alarm → red zone → options card → route to Cache 1 → refill → home. In editing it's compressed to 4 s | 2–3 min | 7 |
| E (backup B1) | `?demo=spe-wildcat` → SPE → pressurized rover (2 min) | 1 min | 7 |
| F | Console, full map with the final route, still | 4 s | 8 |
| G (optional) | `?demo=late-start` → **NO-GO** badge | 3 s | — (page) |

Leave 1 s before and after each take. Large cursor. Don't touch anything during take D.

---

## 5. Editing and sound (Dana's v4, kept)

- **Format:** 1920 × 1080, 30 fps, H.264, **≤ 29.5 s** measured on YouTube. Also export a version without subtitles.
- **Cuts:** a cut every 3–5 s; hard cuts on UI clicks; only two fades (Pinacate → Jezero and the end). Zoom on captures ≤ 130%. Ken Burns ≤ 8% on still photos.
- **Burned-in subtitles:**
  - Narration text verbatim, max 42 characters per line, 2 lines.
  - White on a black box at 60%, Inter/Public Sans 44 px, 8% from the bottom.
  - Labels top left in cyan #4FD1E8; alerts in amber #E07A3F.
- **Music:** ambient electronic 90–100 BPM, no lyrics, from YouTube Audio Library ("Attribution not required") or Pixabay. **Save a screenshot of the license.** −18 LUFS under the voice, −14 LUFS on the title and the ending.
- **Sounds:** real Mars wind (Perseverance, *Sounds of Mars* page, credit NASA/JPL-Caltech); UI clicks, beep and alarm from CC0 libraries.

---

## 6. Rules (rule out anything that disqualifies)

- **Duration:** ≤ 30 s.
- **Language:** English subtitles burned in.
- **NASA branding:** no logos, insignia or seal (meatball, worm, seal); NASA photos credited.
- **AI:** "AI-generated" label on anything made with AI.
- **Music:** royalty-free, or none.
- **People:** no minors.
- **Wording:**
  - "line of sight", never "signal";
  - "checked against", never "validated / proven";
  - caches and the pressurized rover are "mission concept";
  - never name individual tubes ("10 sample tubes" / "Three Forks sample depot");
  - never call Hawksbill a "shelter".
- **Hosting:** YouTube Unlisted or Public, link tested in incognito and on a phone without a login.

**Credits (scene 8, 20 px strip):**
```
Imagery: NASA/JPL-Caltech · Mastcam-Z: NASA/JPL-Caltech/ASU/MSSS · Apollo 14 training, Pinacate 1970: NASA (S70-29540)
Terrain: USGS Astrogeology / NASA Mars 2020 TRN HiRISE DTM · Rover traverse: NASA/JPL MMGIS · Mars audio: NASA/JPL-Caltech
O₂ caches and pressurized rover are mission concepts · Navcam images color-adjusted · Music: [track — license] · Not endorsed by NASA
```

---

## 7. Checklist and owners (to have the video before 21:00)

- [ ] Eric: push to `main` and confirm the Pages deploy in incognito (before Santiago records).
- [ ] Santiago: takes A–F (section 4).
- [ ] Voice: **Dana** records the narration (section 2); measure ≤ 27 s. No TTS, so no "AI-generated voice" label.
- [ ] Editing per sections 2 and 5; subtitles; credits.
- [ ] Review: Dana (science and wording, section 6) and Eric (numbers that match the app).
- [ ] Export ≤ 29.5 s → YouTube → incognito test → link to the project page.

---

## 8. Presentation is also scored on the full project: make everything tell the same story

The guide says judges "evaluate the demo **and full project**" for Presentation. Before 22:00:

- **Same name and tagline everywhere:** MarsWalk · *Plan the walk. Come home.* Project page, video, app, README.
- **Same numbers everywhere:** 1432 m · 190 min · 42% O₂ · 192 min of margin · re-plan in < 1 s · 99.7% within 20 m. They come from `test/jezero_eva.mjs` and `docs/validation/`.
- **Project page images (≤ 10 MB):**
  1. Console screenshot of the O₂ leak (options card).
  2. `docs/img/safe_zone_jezero.png`.
  3. `docs/validation/validation_test2_route_map.png`.
  4. `pipeline/validation/stations_before_after.png`.
- **"Link to Final Project" = the live app** (`https://cheeriosspaceapp.github.io/marswalk/`). The landing has **▶ Launch demo**, so a judge sees it working in one click (Validity: "usable and user-friendly"). The repo goes in the description.
- Project page text: `docs/PROJECT_PAGE.md` merged with Dana's form. Fix:
  - "Space Agency Partner Data: None" → Mars Climate Database (LMD/ESA/CNES).
  - Name → MarsWalk.
  - Fill or remove every `[ ... ]`.
