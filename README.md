# BioPath Studio 🧬
**Clarify crowded biological pathway figures without losing or changing the science.**

## Quick Setup
1. Open the live GitHub Pages link https://jarbaas.github.io/biopath-studio/ (or open `index.html` locally in any modern browser—no build step required).
2. Paste a **Google Gemini API Key** (`AIza...`) into the top-right input box.
3. Click **Upload Figure**, select a pathway image (`example1.jpg` or `example2.jpg`), and click **Improve Figure**.

---

## Core Approach & Scientific Rationale

### 1. Decoupling Biological Extraction from Layout
Standard AI image generators hallucinate garbled text and alter scientific relationships. BioPath Studio instead extracts the image into a **structured biological graph** and renders an interactive vector (SVG) diagram where every protein, complex, and arrow remains editable.

### 2. Three-Pass Pipeline for Scientific Fidelity
* **Pass 1 — Visual Extraction:** Identifies cellular compartments (Plasma Membrane, Cytosol, Nucleus), transmembrane receptors, docked subunits (`JAK`, `STAT3`), multi-subunit complexes (`CARMA1/BCL10/MALT1`, `NEMO/IKKα/IKKβ`), modification badges (`P`, `ub`), and interaction types (`activates` →, `inhibits` ⊣, `translocates` ⇢, `uncertain` ?).
* **Pass 2 — Visual Fidelity Audit:** Converts Pass 1's graph into a structured checklist and cross-checks it against the original image to catch missed arrows, orphaned nodes, or compartment boundary mistakes before rendering.
* **Pass 3 — Scientific Review Wizard:** Flags questionable biology, speculative transitions, and author nomenclature typos as interactive **Apply Fix vs. Keep As Is** cards—ensuring the AI never silently changes the author's original science.

### 3. Visual Improvements for Clarity
* **Standardized Cellular Tiers:** Straightens angled or partial membranes into clear horizontal zones (Membrane → Cytosol → Nucleus) so signal flow reads top-to-bottom.
* **Unified Multi-Subunit Complexes:** Consolidates overlapping piles of shapes into clean dashed subunit containers with standardized `[P]` and `[ub]` badges.
* **Semantic Color-Coding:** Distinguishes activation (`→` slate), inhibition (`⊣` crimson), nuclear translocation (`⇢` dashed indigo), and uncertain links (`?` amber) at a glance.

---

## Results Across the Example Figures

* **Example 1 (JAK-STAT / RTK — Easier):**
  * *What improved:* Untangled the 45° diagonal plasma membrane into a horizontal bilayer; docked `JAK` and `STAT3` cleanly beneath their receptors; preserved subunit-specific inhibition (`SOCS` ⊣ `JAK` and `STAT3`).
  * *Correction workflow:* Preserved the author's `"Scr/Abl"` label during extraction and flagged the `"Scr/Abl" → "Src/Abl"` typo in the Review Wizard.
* **Example 2 (NF-κB Canonical & Non-Canonical — Harder):**
  * *What improved:* Organized 5 receptor families (`TCR/BCR`, `TNFR`, `TLR`, `IL-1R`, `CD40/RANK/LTβR/BAFFR`) into parallel top-to-bottom lanes; grouped 11 multi-protein complexes (`CBM`, `TRADD/TRAF2/5/RIP`, `NEMO/IKK`, `IκBα/p65/p50`); separated cytosolic dimers from nuclear targets.
  * *Correction workflow:* Flagged the speculative `BCL10 --?--> Target Genes` arrow, the inverted `TRAF3/TRAF2/cIAP1/2` constitutive degradation logic on `NIK`, and `BCL3` nuclear localization.

---

## Scientist Controls & Auditability
* **Direct Manipulation:** Drag any element to reposition and pin it (`pinned: true`), double-click any element to edit its label/subunits/zone/color, click any arrow to cycle polarity (`→` / `⊣` / `⇢` / `?`), or `Shift+Click` to delete.
* **Natural Language Corrections:** Type plain-English edits in the bottom prompt bar (e.g., *"Rename Scr/Abl to Src/Abl"*).
* **Full Traceability:** Includes `Undo`/`Redo` (`Ctrl+Z`/`Ctrl+Y`), a timestamped **Revision History Log** (`.txt` export), **Reset to Initial Extract**, and `3x` high-resolution PNG export.

---

## Limitations & What I Would Tackle Next
* **2D Layout on Dense Networks:** Automated layout on highly cross-wired networks (like NF-κB) can still produce tight horizontal spacing or side-by-side co-inhibitors (e.g., `PIAS3` and `KLF4` in Example 1). Making every node draggable and pinnable lets the scientist resolve layout nuances in seconds.
* **Receptor Stoichiometry:** Vision LLMs naturally merge identical symmetric monomers on a receptor tail (e.g., two `JAK` ovals) into a single representative node.
* **Next Steps:**
  1. Add interactive bend-point handles on arrows for manual curve adjustment.
  2. Support explicit monomer stoichiometry counts on homodimeric receptors.
  3. Stream Pass 1 → Pass 2 → Pass 3 progressively to reduce API wait time.
