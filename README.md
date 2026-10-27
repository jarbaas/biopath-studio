# 🧬 BioPath Studio
**Clarify crowded biological pathway figures without losing or changing the science.**

BioPath Studio is an interactive, human-in-the-loop pathway digitization and scientific auditing workspace. It transforms crowded, hard-to-follow published pathway images into clean, structured, and fully editable vector workflow diagrams while preserving 100% of the underlying biological relationships, subunit groupings, post-translational modifications, and regulatory polarities.

---

## 🚀 Quick Start & Setup Instructions

BioPath Studio is a zero-build, client-side web application (`index.html`, `app.js`, `styles.css`) that runs directly in any modern browser or via GitHub Pages.

### Running via Live Link or Locally
1. **Open the Application:**
   * **Live Web Link:** Navigate to the hosted GitHub Pages / Netlify URL.
   * **Local Execution:** Clone or download this repository and open `index.html` directly in Chrome, Edge, Firefox, or Safari (or serve via `npx serve .` / VS Code Live Server).
2. **Configure Your Gemini API Key:**
   * Paste your Google AI Studio Gemini API Key (`AIza...`) into the **Gemini Key** input in the top-right navigation bar.
   * *Multi-Key & Quota Rotation Support:* You may paste multiple comma-separated API keys (`key1, key2`). The engine automatically rotates across available Free Tier quota buckets (`gemini-3.8-flash` $\rightarrow$ `gemini-3.6-flash` $\rightarrow$ `gemini-3-flash` $\rightarrow$ `gemini-2.5-flash` $\rightarrow$ `gemini-3.5-flash-lite`) and remembers exhausted daily buckets in session memory.
3. **Digitize & Audit a Figure:**
   * Click **Upload Figure** in the top bar (or **Choose Image** in Panel 1) and select a pathway image (e.g., `example1.jpg` or `example2.jpg`).
   * Click **Improve Figure** to run the 3-pass extraction, verification, and scientific audit pipeline.

---

## 🎯 The Problem & Product Philosophy

When scientists find a published pathway figure that contains the biology they need, the visual layout often fights comprehension:
* **Distorted Spatial Geometries:** Authors curve cell membranes diagonally across the page to save space (as in Example 1), forcing receptors and cytoplasmic kinases into unnatural corners with long, sharp-angled arrows crossing the figure.
* **Tangled Cross-Pathway Traffic:** Parallel signaling cascades, shared adaptor hubs, and lateral negative regulators (`SOCS`, `PTPs`, `CYLD`, `A20`) slice across activation arrows (as in Example 2).
* **Inconsistent Visual Conventions:** Multi-subunit complexes are drawn as irregular piles of overlapping shapes, and activation, inhibition, and nuclear translocation lines often share identical ink colors.

### Why Generative Image Models Fail Scientists
Asking a diffusion or image-generation model to "redraw" a pathway figure destroys scientific fidelity: image generators hallucinate garbled protein names, silently drop subunits, and invert arrow directions. Worse, they output a flat bitmap image that a scientist cannot edit.

### Our Core Architectural Decision: Decouple Biological Extraction from Layout
BioPath Studio separates **what the biology is** from **how it is arranged on the canvas**:
1. **Multimodal Vision LLMs** act strictly as a **biological graph extractor and scientific peer reviewer**, converting the raster image into a typed, validated JSON biological graph (`zones`, `nodes`, `subunits`, `dockedTo`, `modifications`, `edges`) and a queue of interactive **Scientific Review Cards**.
2. **A Deterministic Graph Compiler & Layout Engine** normalizes cellular compartments into horizontal biological tiers (**Extracellular Space** $\rightarrow$ **Plasma Membrane Bilayer** $\rightarrow$ **Cytosol** $\rightarrow$ **Nucleus**) and renders an interactive SVG workspace where every protein, complex, badge, and arrow remains directly editable by the scientist.

---

## 🔬 Ensuring Scientific Fidelity: The 3-Pass AI Pipeline

A central requirement of scientific software is ensuring that nothing is added, removed, or flipped unintentionally—and giving the scientist visibility and control over every change. BioPath Studio enforces this through a three-pass pipeline:

### Pass 1: Visual Containment & Subunit Digitizer
* **Compartment Identification (`zones`):** Identifies drawn boundaries and orders them from outermost (`order: 0`) to innermost (`membrane_bilayer`, `open_region`, `enclosed_organelle`, `outcome_banner`).
* **Visual Containment Assignment:** Assigns every labeled entity to its cellular compartment strictly by its physical position relative to drawn boundary contours.
* **Docked Subunits (`dockedTo`) vs. Multi-Subunit Complexes (`subunits`):**
  * Subunits physically touching a receptor tail or scaffold without an arrow (e.g., `JAK` and `STAT3` on the `IL-6 Receptor` tail, or `TRAF3/TRAF2/cIAP1/2` on `CD40`) are linked via `dockedTo` and snapped directly beneath their host receptor.
  * Free-standing multi-protein complexes (`CARMA1 / BCL10 / MALT1 / TRAF6`, `NEMO / IKKα / IKKβ`, `IκBα / p65 / p50`, `STAT3 / STAT3` dimers) are grouped into unified dashed complex containers (`multi_subunit_cluster`) with individual subunit pills.
* **Post-Translational Modification Badges (`modifications`):** Small attached modifier circles (`P`, `ub`, `GTP`, `GDP`, `Me`, `Ac`) are absorbed into their parent node's `modifications` array and rendered as standardized top-right badges. A compiler pass (`isStandaloneModifierNode`) guarantees that standalone `"P"` or `"ub"` circles never become orphan protein nodes.
* **Subunit-Level Edge Tracing (`edges`):** Traces every drawn interaction to its exact target subunit and classifies it into one of four semantic types:
  * `activates` ($\rightarrow$, solid slate-grey arrow)
  * `inhibits` ($\dashv$, solid crimson T-bar)
  * `translocates` ($\dashrightarrow$, dashed indigo arrow crossing compartment boundaries)
  * `uncertain` ($?$, dashed amber arrow with a highlighted `?` badge)

### Pass 2: Automated Visual Fidelity & Completeness Auditor
Before the scientist even begins their review, Pass 1's compiled graph is converted into a human-readable compartment and interaction checklist (`buildReadablePass2Checklist`) and sent back to the vision model alongside the original image:
* **Orphan & Missing Arrow Audit:** Inspects every node with `Incoming arrows: none` or `Outgoing arrows: none` against the source image to recover any missed activation, translocation, or inhibition lines.
* **Subunit T-Bar Precision:** Verifies that inhibitors with multiple T-bar branches pointing to distinct subunits of a complex (such as `SOCS` inhibiting both docked `JAK` and docked `STAT3` under `IL-6 Receptor`) preserve both individual `inhibits` edges.
* **Boundary Contour Verification:** Ensures cytosolic complexes with dashed translocation arrows ($\dashrightarrow$) crossing into the nucleus remain in the `Cytosol` compartment rather than being prematurely placed inside the `Nucleus`.

### Pass 3: Senior Scientific & Mechanistic Auditor (Interactive Review Wizard)
Pass 1 and Pass 2 never silently "correct" the original author's biology—even if the original figure contains a spelling typo or a questionable biological shortcut. Instead, Pass 3 acts as a senior cell signaling peer reviewer and generates **3 to 5 interactive Review Cards** across five scientific dimensions:
1. **Nomenclature & Author Typos (`nomenclature_or_visual`):** Flags author typos (such as `"Scr/Abl"` in Example 1) and offers a 1-click patch to rename it to `"Src/Abl"`.
2. **Unverified or Speculative Transitions (`biological_plausibility`):** Flags speculative `?` edges (such as cytosolic `BCL10 --?--> Target Genes` in Example 2) so the scientist can choose to remove the unverified link or keep the author's hypothesis.
3. **Inverted Regulatory Logic (`biological_plausibility`):** Flags mechanistically inverted arrows (such as `TRAF3 / TRAF2 / cIAP1/2` drawn with a standard arrow to `NIK` in Example 2, when biologically the complex constitutively ubiquitinates `NIK` for degradation).
4. **Subcellular Localization (`biological_plausibility`):** Flags proteins placed outside their canonical functional compartment (such as the nuclear co-activator `BCL3` drawn in the cytosol in Example 2).
5. **State Transition Condensation (`state_transition_choice`):** Offers to condense redundant precursor/active state pairs if the scientist wants a more compact diagram.

---

## 🛠️ Interactive Scientist-in-the-Loop Controls

Scientists need direct, granular control to spot mistakes, test changes, and customize the final figure:

* **Guided Review Wizard (Panel 2):** Step through each flagged scientific observation (`← Prev` / `Next →`). The active review card highlights the exact affected nodes on the SVG canvas with a pulsing indigo ring. Clicking **Apply Fix** executes a validated transactional graph patch (`applyPatch`); clicking **Keep As Is** logs the decision to preserve the original author's design.
* **Direct Canvas Manipulation (Panel 3):**
  * **Drag-and-Pin Positioning:** Drag any node to refine its position. Dragged nodes are automatically marked `pinned: true` so subsequent AI patches or review fixes never overwrite the scientist's manual layout adjustments.
  * **Double-Click Element Editor Modal:** Double-click any node (or click `+ Add Element`) to edit its label, comma-separated subunits, modification badges (`P, ub`), visual shape (`oval`, `pill`, `transmembrane`, `multi_subunit_cluster`, `proteasome`, `dna_target`, `starburst`, `banner`), cellular zone, or fill color.
  * **1-Click Arrow Polarity Cycling:** Click any arrow on the canvas to cycle its polarity (`activates` $\rightarrow$ `inhibits` $\dashv$ `translocates` $\dashrightarrow$ `uncertain` $?$), or `Shift + Click` to delete an arrow.
  * **Interactive Biological Hover Inspector:** Hovering over any element displays a floating tooltip with its cellular compartment, functional role, physical docking parent or subunits, and upstream/downstream connections.
* **Natural Language Correction Bar (Panel 4):** Type plain-English instructions (e.g., *"Change all phosphorylation badges to capital P"*, *"Rename Scr/Abl to Src/Abl"*, or *"Add an inhibition arrow from A20 to NEMO"*) to apply transactional patches to the current graph.
* **Full Auditability & Export:**
  * **Undo / Redo (`Ctrl+Z` / `Ctrl+Y`):** Full 40-step state snapshot stack covering wizard actions, manual drags, modal edits, and natural-language prompts.
  * **Reset to Initial Extract:** Restores the baseline post-Pass 2 digitized snapshot in one click.
  * **Chronological Revision History & `.txt` Report Export:** Every automated pass and user edit is timestamped in the Revision History panel and can be exported as a structured plain-text audit report (`Export Log`).
  * **Publication-Grade `3x` PNG Export (`Export PNG`):** Rasterizes the vector SVG canvas at $3\times$ resolution with clean typography and a white background for slide decks or manuscripts.

---

## 📊 Case Studies: What Worked Differently Across Examples 1 & 2

### Example 1: JAK-STAT & RTK Signaling (`example1.jpg`)
* **What Made the Original Figure Hard to Read:**
  * The plasma membrane was drawn as a steep diagonal arc from bottom-left to top-right, pushing `Receptor Tyrosine Kinase` and `Scr/Abl` down into the bottom-left corner and forcing a long, sharp-angled bypass line underneath the entire diagram to reach `Target Genes`.
* **How BioPath Studio Improved It:**
  * **Membrane Normalization:** Straightened the curved membrane into a horizontal lipid bilayer at the top of the cell, placing `Receptor Tyrosine Kinase` and `IL-6 Receptor` on the same horizontal tier so both converge symmetrically onto the cytosolic `[STAT3 | STAT3]` dimer.
  * **Receptor-Tail Docking & Subunit Inhibition:** Preserved `JAK` and `STAT3` docked directly beneath the `IL-6 Receptor` tail, and preserved both distinct red T-bar lines (`⊣`) from `SOCS` to the docked `JAK` and `STAT3` subunits.
  * **Scientific Audit Catch:** Faithfully extracted the author's original `"Scr/Abl"` label in Pass 1 without silent alteration, then immediately flagged `"Scr/Abl" -> "Src/Abl"` in the Review Wizard alongside the non-canonical direct nuclear bypass arrow.

### Example 2: Canonical & Non-Canonical NF-$\kappa$B Signaling (`example2.jpg`)
* **What Made the Original Figure Hard to Read:**
  * Five distinct receptor inputs (`TCR/BCR`, `TNFR`, `TLR`, `IL-1R`, `CD40/RANK/LTβR/BAFFR`) fed into a dense web of 31 cytosolic and nuclear elements, with overlapping subunit piles, uncolored inhibition T-bars slicing across activation cascades, and a partial dashed nuclear arc.
* **How BioPath Studio Improved It:**
  * **Parallel Receptor Columns & Horizontal Effector Row:** Aligned all 5 receptor families evenly across the top plasma membrane bilayer, organized each receptor's downstream adaptors (`CARMA1/BCL10/MALT1/TRAF6`, `TRADD/TRAF2/5/RIP`, `MYD88/IRAKs`, `TRIF/TRAF6`, and the non-canonical `NIK` $\rightarrow$ `IKKα` $\rightarrow$ `p100/RelB` $\rightarrow$ `p52/RelB` spine) into vertical lanes, and preserved the central horizontal canonical processing row (`[NEMO | IKKα | IKKβ]` $\rightarrow$ `[IκBα | p65 | p50]` $\rightarrow$ `proteasome`).
  * **Multi-Subunit Consolidation:** Converted irregular overlapping piles of ovals/rectangles into clean, uniform dashed multi-subunit containers with standardized `[P]` and `[ub]` badges.
  * **Scientific Audit Catches:** Generated 4 high-value review cards:
    1. Flagged the speculative `?` arrow from cytosolic `BCL10` to `Target Genes`.
    2. Flagged the regulatory logic of `TRAF3 / TRAF2 / cIAP1/2` on `NIK` (constitutive ubiquitin-mediated degradation vs. activation).
    3. Flagged the subcellular localization of the nuclear co-activator `BCL3`.
    4. Flagged the cross-talk arrow from `NIK` to the canonical `TAB2/3 / TAK1` complex.

---

## ⚖️ Honest Limitations & What I Would Tackle Next

### Current Limitations
1. **Automated 2D Layout vs. Dense Multi-Branch Networks:**
   * Laying out biological pathways with simultaneous vertical cascades, horizontal proteolytic handoffs, lateral co-inhibitors, and long feedback loops is a constrained compound-graph problem. For example, when two lateral inhibitors target the same complex in the same compartment (such as `PIAS3` and `KLF4` inhibiting nuclear `STAT3` in Example 1), our single-row lateral placement lines them up horizontally rather than stacking them vertically. Because every node supports **drag-and-pin**, the scientist can drag `PIAS3` above `KLF4` in one second to achieve the exact publication polish they want.
2. **Symmetric Monomer Stoichiometry on Receptor Tails:**
   * When a receptor tail has two identical monomers drawn symmetrically on its left and right flanks (e.g., two `JAK` ovals on `Receptor Tyrosine Kinase` in Example 1), multimodal vision LLMs naturally consolidate identical sibling monomers on the same parent into a single representative docked node (`JAK`).
3. **Multi-Pass Vision API Latency:**
   * Running three sequential multimodal passes (Extraction $\rightarrow$ Visual Verification $\rightarrow$ Scientific Audit) takes ~15–25 seconds on standard Gemini Flash endpoints, trading sub-second speed for higher graph completeness and self-correction.

### What I Would Tackle Next (Product Roadmap)
1. **Interactive Orthogonal/Spline Edge Bend-Point Handles:** Allow the user to drag the midpoint of any curved arrow to customize its routing channel, alongside port-level snapping on specific subunits within a `multi_subunit_cluster`.
2. **Explicit Stoichiometry & Homodimer Badges (`2x JAK`):** Add a stoichiometry property (`count: 2`) to docked receptor subunits so symmetric homodimer tails render as paired Left/Right subunits automatically.
3. **Side-by-Side Diff Overlay & Original Bounding-Box Highlighting:** Clicking a node or arrow in the improved SVG diagram could highlight the corresponding `[origX, origY]` bounding box directly on the original uploaded image in Panel 1 for instant visual cross-checking.
4. **Progressive Streaming Pipeline:** Stream Pass 1 $\rightarrow$ Pass 2 $\rightarrow$ Pass 3 via Server-Sent Events so the scientist can begin inspecting and dragging the Pass 1 diagram immediately while Pass 2 and Pass 3 stream in background badges.
