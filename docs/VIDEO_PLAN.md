# MarsWalk — final 30-second video plan (v5, merged)

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
| 8 | Plan B1 (SPE → pressurized rover) **is no longer needed** but is recorded as backup | Both are verified: `test/jezero_eva.mjs` checks SPE at Wildcat → `shelter-sev-rover-01` and leak → cache rescue, and exits with an error if either breaks. |

**Dana's open items, resolved:**
- Team name: **CheeriOS**.
- DTM source: **USGS Astrogeology / NASA, Mars 2020 TRN HiRISE DTM mosaic of Jezero** (`JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m`).
- Leak → `resupply` with `stations.geojson`: works (preset `leak-cache`).
- SPE → `shelter-sev-rover-01`: yes.
- HUD uses the 18% reserve (393.6 usable min): yes.

---

## 1. Message

- **Main idea (EN):** *MarsWalk turns real NASA data of Mars into EVA routes that always keep a way home, and re-plans them when something goes wrong.*
- **Three things the judge must remember:**
  1. Real NASA terrain and data.
  2. It computes and *explains* the route (the safe zone, the options card).
  3. It is checked against Perseverance's real drive.
- **Arc** (Dana's "Half the walk": on Mars, getting there is only half the walk; the other half is coming back):
  - 0:00–0:10 who we are and the problem.
  - 0:10–0:21 how it works and the crisis.
  - 0:21–0:30 the future.

---

## 2. Master storyboard (≤ 29.5 s)

Columns: what you see · what's happening (action in the app) · what's said (EN narration = burned-in subtitles) · on-screen text · audio.

| # | Time | What you see | What's happening | Narration (EN) | On-screen text | Audio |
|---|---|---|---|---|---|---|
| 1 | 0:00–0:02 | **ph-tf-11** (Navcam sol 658: plain with rover tracks, hills), slow push-in ≤ 8% | Intro, official guide: name + team | "I'm [NAME], with team CheeriOS." | **CheeriOS** · [first names of the 6] · [Local Event], Mexico | Real Mars wind (Perseverance) + low pad |
| 2 | 0:02–0:06 | **S70-29540** (Shepard, El Pinacate, 1970) → 12-frame crossfade with horizons aligned → **ph-hab-01** (habitat site, Jezero) | Challenge + inspiration | "Apollo trained in Sonora. Our challenge: the first Marswalk." | Top: *Challenge: Martian Map* · Bottom: *Pinacate, Sonora · 1970 → Jezero Crater, Mars* | Synth pulse comes in |
| 3 | 0:06–0:10 | Console hillshade (3 × 3 km) with the targets as pins coming in one by one | Title | "MarsWalk. *(pause)* Plan the walk. Come home." | **MARSWALK** / *Plan the walk. Come home.* / *EVA routes computed from NASA data* | Music hit on the title |
| 4 | 0:10–0:13 | **Real capture, console** (`?demo=eva1-nominal`): layers slope → hazard → line of sight, 0.7 s each → the route draws itself with the **safe zone** (red) around it | Data → cost → route | "NASA terrain sets an oxygen cost for every step." | Left chips (cyan): *HiRISE DTM · USGS/NASA* → *Slope · Hazard · Line of sight* → *O₂ minutes per 3 m cell* → **GO** (the app's badge) | Soft UI clicks |
| 5 | 0:13–0:15 | Validation figure `docs/validation/validation_test2_route_map.png`, panel for sols 538→543 (our route + Perseverance's path in red) | Science credibility | "Checked against Perseverance's real path." | Top band: **99.7% of the rover's track within 20 m of our route** (open plain) · small: *NASA/JPL MMGIS* | Stronger pulse |
| 6 | 0:15–0:16.5 | **Real capture, tablet:** POV card at Wildcat Ridge (ph-wr-01 = PIA24928), push-in | The astronaut sees the place before getting there | — (no voice) | *Real Perseverance photo, placed by its own image ID* · credit *NASA/JPL-Caltech/ASU/MSSS* | Subtle telemetry beep |
| 7 | 0:16.5–0:21 | **Key shot, split screen console + tablet** (`?demo=leak-cache`): 2-frame red flash → tablet alarm → **red zone closes in** → options card **Habitat ✗ not enough O₂ · Cache 1 ✓** → new route in < 1 s → **refill +120** → route home | Crisis and resolution | "An oxygen leak? It finds a cache, and the way home." | Top band: **ALERT: O₂ leak** (red) → **Rerouted in under a second: O₂ cache → habitat** (amber) · next to the cache: *O₂ cache (mission concept)* | Two-tone 0.5 s alarm · music drops, 0.8 s of drone · comes back when the route redraws |
| 8 | 0:21–0:30 | Zoom out from the full route over Jezero (3 s) → S70-29540 again, warm tone (3 s) → end card (3 s) | The future (official guide 0:20–0:30) | "Tomorrow, it could guide the first Marswalk. Today, crews training in deserts like Pinacate. Every walk, planned to come home." | *Mars · the Moon · Earth analog sites* → **Plan the walk. Come home.** · *Built on open NASA data* · credits strip | Music builds and resolves · 1 s of wind at the end |

**Narration:** 65 words in ~27 s (2.4 words/s), with 1.5 s of silence in scene 6. Tone: calm mission controller, no trailer drama. Short pause before "Come home". Pronunciation: Jezero = *JEZ-eh-roh*, Pinacate = *pee-nah-KAH-teh*.

**If the voice runs over 27 s,** cut in this order:
1. Line 8 → "Tomorrow, the first Marswalk. Today, desert training crews. Every walk, planned to come home."
2. Line 2 → "Our challenge: the first Marswalk." (Apollo stays only as on-screen text.)

Lines 1, 4, 5 and 7 are never cut: they carry the name, the data, the validation and the story.

**TTS (if there's no human voice):**
```
<speak>I'm [NAME], with team CheeriOS. <break time="300ms"/>
Apollo trained in Sonora. <break time="200ms"/> Our challenge: the first Marswalk. <break time="500ms"/>
MarsWalk. <break time="300ms"/> Plan the walk. <break time="300ms"/> Come home. <break time="500ms"/>
NASA terrain sets an oxygen cost for every step. <break time="300ms"/>
Checked against Perseverance's real path. <break time="1500ms"/>
An oxygen leak? <break time="400ms"/> It finds a cache, and the way home. <break time="600ms"/>
Tomorrow, it could guide the first Marswalk. <break time="300ms"/> Today, crews training in deserts like
<phoneme alphabet="ipa" ph="pinaˈkate">Pinacate</phoneme>. <break time="400ms"/> Every walk, planned to come home.</speak>
```
If it's TTS: the label **"AI-generated voice"** stays on screen the whole video (top right, 18 px), and goes in the YouTube description and the AI field.

---

## 3. What each scene wins (judging criteria, same weight each)

| Criterion | Scene | What proves it |
|---|---|---|
| **Relevance** (NASA data as the engine) | 1, 4, 6 | HiRISE DTM → cost; real Perseverance photos placed by image ID |
| **Validity** (sound science) | 5, 7 | 99.7% vs the rover; the app's real numbers; "mission concept" labels |
| **Creativity** (never-seen approach) | 4, 7 | The live safe zone + the options card (the planner *reasons*), replanning in < 1 s |
| **Impact** | 2, 8 | First human EVA on Mars; the same engine for the Moon and Earth analogs |
| **Presentation** | all | One idea per scene, 32 px+ text, subtitles, the tagline repeated at the start and the end |

---

## 4. Takes to record (Santiago): 1920 × 1080, 60 fps, incognito, browser zoom 100%, no bookmarks bar or notifications

Base URL: `https://cheeriosspaceapp.github.io/marswalk/` (or `npm run dev` → `http://localhost:5173/`).
Open the **console and the tablet side by side in the same browser** (a hidden window gets paused).

| Take | URL / action | Duration to record | Scene |
|---|---|---|---|
| A | `console.html?site=jezero` → turn on Slope, Hazard, No comms (1 s each) | 6 s | 4 |
| B | `console.html?site=jezero&demo=eva1-nominal` + `tablet.html?site=jezero&demo=1` → the route draws itself, **GO** badge, red zone | 8 s | 3–4 |
| C | Tablet arriving at Wildcat Ridge → POV card ph-wr-01 (with the `eva1-nominal` preset; speed it up with the tablet's speed button) | 5 s | 6 |
| D (**key**) | `console.html?site=jezero&demo=leak-cache` + `tablet.html?site=jezero&demo=1`. **Record without cutting** from the end of the survey task until the habitat ingress (~2 min real): alarm → red zone → options card → route to Cache 1 → refill → home. In editing it's compressed to 4.5 s | 2–3 min | 7 |
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
- [ ] Voice: a team member (preferred) or TTS with the label; measure ≤ 27 s.
- [ ] Editing per sections 2 and 5; subtitles; credits.
- [ ] Review: Dana (science and wording, section 6) and Eric (numbers that match the app).
- [ ] Export ≤ 29.5 s → YouTube → incognito test → link to the project page.
