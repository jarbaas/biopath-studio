window.App = (() => {
  let state = null;
  let initialDigitizedSnapshot = null;
  let undoStack = [];
  let redoStack = [];
  let currentIssueIndex = 0;
  let showCompletedReviewBanner = false;
  let uploadedImageBase64 = null;

  // Session-level memory of (keyIndex::modelName) pairs that hit a DAILY quota limit
  // so subsequent passes skip known daily-exhausted buckets in 0ms without retrying.
  const exhaustedDailyKeyModels = new Set();

  // Non-destructive pointer drag state
  let dragTarget = null;
  let dragElement = null;
  let dragStartPt = { x: 0, y: 0 };
  let dragOffset = { x: 0, y: 0 };
  let hasMoved = false;
  let preDragSnapshot = null;

  // Modal editing state
  let editingNodeId = null;

  const DEFAULT_MODEL_NAME = "gemini-3.8-flash";
  const FALLBACK_MODELS = [
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3-flash",
    "gemini-2.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite"
  ];
  const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB
  const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
  const VALID_SHAPES = new Set([
    "pill", "oval", "transmembrane", "multi_subunit_cluster",
    "starburst", "proteasome", "dna_target", "banner"
  ]);
  const VALID_EDGE_TYPES = new Set(["activates", "inhibits", "translocates", "uncertain"]);
  const VALID_ZONE_STYLES = new Set([
    "membrane_bilayer", "open_region", "enclosed_organelle", "outcome_banner"
  ]);

  const MODIFIER_TOKENS = new Set([
    "p", "(p)", "po4", "phospho", "phosphorylation",
    "ub", "(ub)", "ubiquitin", "ubiquitination",
    "gtp", "gdp", "me", "methyl", "ac", "acetyl", "sumo", "oh"
  ]);

  const PLACEHOLDER_LABEL_REGEX = /\b(putative|canonical|intermediate|unknown|unspecified|hypothetical|missing_node|placeholder|tbd)\b|\(|\.\.\./i;

  // Maximum vertical dead-space allowed between consecutive elements in a compartment
  const MAX_VERTICAL_GAP = 85;

  // ============================================================================
  // 0. SECURITY / ESCAPING & STREAMLINED UI SYNC
  // ============================================================================
  function escapeHtml(raw) {
    const str = String(raw ?? "");
    return str
      .replace(/&/g, "&" + "amp;")
      .replace(/</g, "&" + "lt;")
      .replace(/>/g, "&" + "gt;")
      .replace(/"/g, "&" + "quot;")
      .replace(/'/g, "&" + "#39;");
  }

  function getModelName() {
    const sel = document.getElementById("modelSelectInput");
    if (sel && sel.value) return sel.value.trim();
    const stored = (
      sessionStorage.getItem("biopath_gemini_model") ||
      localStorage.getItem("biopath_gemini_model") ||
      ""
    ).trim();
    if (!stored || stored === "gemini-3.5-flash-lite" || stored === "gemini-3.5-flash") {
      return DEFAULT_MODEL_NAME;
    }
    return stored;
  }

  function saveModelName(val) {
    const cleaned = String(val || DEFAULT_MODEL_NAME).trim();
    sessionStorage.setItem("biopath_gemini_model", cleaned);
    localStorage.setItem("biopath_gemini_model", cleaned);
  }

  function getRawKeyString() {
    const input = document.getElementById("apiKeyInput");
    const fromInput = input?.value ? input.value.trim() : "";
    if (fromInput) return fromInput;
    return (
      sessionStorage.getItem("biopath_gemini_key") ||
      localStorage.getItem("biopath_gemini_key") ||
      ""
    ).trim();
  }

  function getApiKeysList() {
    const raw = getRawKeyString();
    if (!raw) return [];
    return Array.from(
      new Set(
        raw
          .split(/[\s,;]+/)
          .map(k => k.trim())
          .filter(Boolean)
      )
    );
  }

  function saveApiKey(val) {
    const cleaned = String(val || "").trim();
    exhaustedDailyKeyModels.clear();
    if (cleaned) {
      sessionStorage.setItem("biopath_gemini_key", cleaned);
      localStorage.setItem("biopath_gemini_key", cleaned);
    } else {
      sessionStorage.removeItem("biopath_gemini_key");
      localStorage.removeItem("biopath_gemini_key");
    }
  }

  function syncCleanUI() {
    // Remove any leftover debug export button if present in DOM
    const oldDbgBtn = document.getElementById("exportDebugJsonBtn");
    if (oldDbgBtn) oldDbgBtn.remove();

    const keyInput = document.getElementById("apiKeyInput");
    if (keyInput) {
      keyInput.placeholder = "Paste Gemini API Key(s) (comma-separated supported)";
    }

    if (!document.getElementById("modelSelectInput")) {
      if (keyInput && keyInput.parentElement) {
        const select = document.createElement("select");
        select.id = "modelSelectInput";
        select.title = "Select Primary Gemini Model (auto-falls back across available quota buckets)";
        select.className =
          "text-xs border border-slate-300 rounded-lg px-2 py-1.5 bg-white text-slate-700 font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500";
        const options = [
          { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash (Default)" },
          { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
          { value: "gemini-3-flash", label: "Gemini 3 Flash" },
          { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
          { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
          { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" }
        ];
        const saved = getModelName();
        select.innerHTML = options
          .map(o => `<option value="${o.value}" ${o.value === saved ? "selected" : ""}>${o.label}</option>`)
          .join("");
        select.addEventListener("change", e => saveModelName(e.target.value));
        keyInput.parentElement.insertBefore(select, keyInput);
      }
    }

    document.querySelectorAll("h2, h3, p, span, div, button").forEach(el => {
      if (el.children.length === 0 && el.textContent) {
        const txt = el.textContent.trim();
        if (/fidelity\s*&\s*corrections/i.test(txt)) {
          el.textContent = txt.replace(/fidelity\s*&\s*corrections/i, "Scientific Review");
        } else if (/catch added,\s*dropped,\s*or flipped science\.?/i.test(txt)) {
          el.textContent = "Step through flagged pathway questions, nomenclature fixes, and manual edits.";
        }
      }
      if (el.tagName === "BUTTON") {
        const bTxt = (el.textContent || "").trim();
        const onClickAttr = el.getAttribute("onclick") || "";
        if (
          /^auto-align$/i.test(bTxt) ||
          /^reset layout$/i.test(bTxt) ||
          /recomputeCleanLayout/i.test(onClickAttr) ||
          /apply suggested layout/i.test(bTxt) ||
          /recheck v original/i.test(bTxt) ||
          /reverifyBiologyForContext/i.test(onClickAttr)
        ) {
          el.classList.add("hidden");
          el.style.display = "none";
        }
      }
    });

    const batchBtn = document.getElementById("batchFixBtn");
    if (batchBtn) {
      batchBtn.classList.add("hidden");
      batchBtn.style.display = "none";
    }
    const revBtn = document.getElementById("reverifyBtn");
    if (revBtn) {
      revBtn.classList.add("hidden");
      revBtn.style.display = "none";
    }
    const ctxInput = document.getElementById("biologicalContextInput");
    if (ctxInput) {
      ctxInput.readOnly = true;
      ctxInput.className = "text-xs font-bold text-slate-800 bg-transparent border-none focus:outline-none pointer-events-none";
    }
  }

  // ============================================================================
  // 1. UNDO / REDO HISTORY MANAGEMENT
  // ============================================================================
  function createHistorySnapshot() {
    if (!state) return null;
    return JSON.stringify({
      state,
      currentIssueIndex,
      showCompletedReviewBanner
    });
  }

  function restoreHistorySnapshot(serialized) {
    if (!serialized) return;
    const parsed = JSON.parse(serialized);
    if (parsed && parsed.state) {
      state = parsed.state;
      currentIssueIndex = Number.isInteger(parsed.currentIssueIndex) ? parsed.currentIssueIndex : 0;
      showCompletedReviewBanner = Boolean(parsed.showCompletedReviewBanner);
    } else {
      state = parsed;
      showCompletedReviewBanner = false;
    }
  }

  function pushUndoSnapshot() {
    const snap = createHistorySnapshot();
    if (!snap) return;
    undoStack.push(snap);
    if (undoStack.length > 40) undoStack.shift();
    redoStack = [];
    updateUndoRedoButtons();
  }

  function undo() {
    if (!state || undoStack.length === 0) return;
    const currentSnap = createHistorySnapshot();
    if (currentSnap) redoStack.push(currentSnap);
    restoreHistorySnapshot(undoStack.pop());
    updateUndoRedoButtons();
    renderAll();
  }

  function redo() {
    if (!state || redoStack.length === 0) return;
    const currentSnap = createHistorySnapshot();
    if (currentSnap) undoStack.push(currentSnap);
    restoreHistorySnapshot(redoStack.pop());
    updateUndoRedoButtons();
    renderAll();
  }

  function updateUndoRedoButtons() {
    const uBtn = document.getElementById("undoBtn");
    const rBtn = document.getElementById("redoBtn");
    if (uBtn) uBtn.disabled = undoStack.length === 0;
    if (rBtn) rBtn.disabled = redoStack.length === 0;
  }

  window.addEventListener("keydown", e => {
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
    }
  });

  // ============================================================================
  // 2. GRAPH COMPILER
  // ============================================================================
  function normalizeModBadge(rawMod) {
    const s = String(rawMod || "").trim();
    if (!s) return "";
    const low = s.toLowerCase();
    if (low.includes("phospho") || low === "p" || low === "(p)" || low === "po4") return "P";
    if (low.includes("ubiquit") || low === "ub" || low === "(ub)") return "ub";
    if (low.includes("methyl") || low === "me") return "Me";
    if (low.includes("acetyl") || low === "ac") return "Ac";
    if (low.includes("sumo")) return "SUMO";
    if (low.includes("gtp")) return "GTP";
    if (low.includes("gdp")) return "GDP";
    return s.length > 4 ? s.slice(0, 3).toUpperCase() : s;
  }

  function isStandaloneModifierNode(node) {
    const clean = String(node?.label || "").trim().toLowerCase();
    return MODIFIER_TOKENS.has(clean);
  }

  function normalizeSubunits(label, rawSubunits) {
    const list = (Array.isArray(rawSubunits) ? rawSubunits : [])
      .map(s => String(s || "").trim())
      .filter(s => s && s.toLowerCase() !== "undefined" && s.toLowerCase() !== "null");

    if (list.length >= 2) {
      return list;
    }
    if (list.length === 1) {
      const normLbl = String(label || "").toLowerCase().replace(/[\s/•,+-]+/g, "");
      const normSub = list[0].toLowerCase().replace(/[\s/•,+-]+/g, "");
      return normLbl === normSub ? [] : list;
    }
    const slashParts = String(label || "")
      .split(/\s+\/\s+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (slashParts.length === 2 && slashParts[0].toLowerCase() === slashParts[1].toLowerCase()) {
      return slashParts;
    }
    return [];
  }

  function sourceDistance(a, b) {
    if (!a || !b) return 0;
    const ax = a.sourcePosition?.x ?? a.origX ?? 500;
    const ay = a.sourcePosition?.y ?? a.origY ?? 500;
    const bx = b.sourcePosition?.x ?? b.origX ?? 500;
    const by = b.sourcePosition?.y ?? b.origY ?? 500;
    return Math.hypot(ax - bx, ay - by);
  }

  function resolveNode(identifier, fallbackIds = [], excludeId = null, targetGraph = state, anchorNode = null) {
    if (!targetGraph || !Array.isArray(targetGraph.nodes)) return null;
    const pool = targetGraph.nodes.filter(n => n && n.id !== excludeId);
    const primaryCand = String(identifier ?? "").trim();
    const fallbacks = (Array.isArray(fallbackIds) ? fallbackIds : [])
      .map(x => String(x ?? "").trim())
      .filter(Boolean);

    const pickClosest = candidates => {
      if (!candidates || candidates.length === 0) return null;
      if (candidates.length === 1) return candidates[0];
      if (!anchorNode) return candidates[0];
      return [...candidates].sort((a, b) => sourceDistance(a, anchorNode) - sourceDistance(b, anchorNode))[0];
    };

    if (primaryCand) {
      const low = primaryCand.toLowerCase();
      const exactId = pool.find(n => n.id === primaryCand || n.id.toLowerCase() === low);
      if (exactId) return exactId;

      const exactLblMatches = pool.filter(n => n.label.toLowerCase() === low);
      if (exactLblMatches.length === 1) return exactLblMatches[0];
      if (exactLblMatches.length > 1) return pickClosest(exactLblMatches);
    }

    for (const fb of fallbacks) {
      const lowFb = fb.toLowerCase();
      const byId = pool.find(n => n.id === fb || n.id.toLowerCase() === lowFb);
      if (byId) return byId;
      const byLbl = pool.filter(n => n.label.toLowerCase() === lowFb);
      if (byLbl.length === 1) return byLbl[0];
      if (byLbl.length > 1) return pickClosest(byLbl);
    }

    const allCandidates = [primaryCand, ...fallbacks].filter(Boolean);
    for (const cand of allCandidates) {
      const low = cand.toLowerCase();
      if (low.length < 2) continue;
      const partialMatches = pool.filter(
        n =>
          n.id.toLowerCase().includes(low) ||
          low.includes(n.id.toLowerCase()) ||
          n.label.toLowerCase().includes(low) ||
          low.includes(n.label.toLowerCase())
      );
      if (partialMatches.length === 1) return partialMatches[0];
      if (partialMatches.length > 1) return pickClosest(partialMatches);
    }
    return null;
  }

  function resolveEdgeEndpoints(rawSource, rawTarget, fallbackIds = [], targetGraph = state) {
    if (!targetGraph || !Array.isArray(targetGraph.nodes)) return { s: null, t: null };
    const getCandidates = ident => {
      const str = String(ident ?? "").trim();
      if (!str) return [];
      const low = str.toLowerCase();
      const exactId = targetGraph.nodes.filter(n => n.id === str || n.id.toLowerCase() === low);
      if (exactId.length > 0) return exactId;
      const exactLbl = targetGraph.nodes.filter(n => n.label.toLowerCase() === low);
      if (exactLbl.length > 0) return exactLbl;
      const partial = targetGraph.nodes.filter(
        n =>
          n.id.toLowerCase().includes(low) ||
          low.includes(n.id.toLowerCase()) ||
          n.label.toLowerCase().includes(low) ||
          low.includes(n.label.toLowerCase())
      );
      return partial;
    };

    let sCands = getCandidates(rawSource);
    let tCands = getCandidates(rawTarget);

    if (sCands.length === 0 && fallbackIds.length > 0) {
      const fbS = resolveNode(rawSource, fallbackIds, null, targetGraph);
      if (fbS) sCands = [fbS];
    }
    if (tCands.length === 0 && fallbackIds.length > 0) {
      const fbT = resolveNode(rawTarget, fallbackIds, sCands[0]?.id, targetGraph, sCands[0]);
      if (fbT) tCands = [fbT];
    }

    if (sCands.length === 0 || tCands.length === 0) return { s: null, t: null };

    let bestPair = { s: null, t: null, dist: Infinity };
    for (const sc of sCands) {
      for (const tc of tCands) {
        if (sc.id === tc.id) continue;
        const d = sourceDistance(sc, tc);
        if (d < bestPair.dist) {
          bestPair = { s: sc, t: tc, dist: d };
        }
      }
    }
    return { s: bestPair.s, t: bestPair.t };
  }

  function resolveZoneId(zoneIdentifier, targetGraph = state) {
    if (!targetGraph || !Array.isArray(targetGraph.zones) || targetGraph.zones.length === 0) {
      return "zone_0";
    }
    const raw = String(zoneIdentifier ?? "").trim();
    if (!raw) return null;
    const low = raw.toLowerCase();

    const byId = targetGraph.zones.find(z => z.id.toLowerCase() === low);
    if (byId) return byId.id;

    const byLabel = targetGraph.zones.find(
      z => z.label.toLowerCase().includes(low) || low.includes(z.label.toLowerCase())
    );
    if (byLabel) return byLabel.id;

    const byStyle = targetGraph.zones.find(z => z.visualStyle.toLowerCase() === low);
    if (byStyle) return byStyle.id;

    return null;
  }

  function getRootDockAnchor(node, nodeMap) {
    let curr = node;
    const visited = new Set();
    while (curr && curr.dockedTo && !visited.has(curr.id)) {
      visited.add(curr.id);
      const parent = nodeMap.get(curr.dockedTo);
      if (!parent) break;
      curr = parent;
    }
    return curr || node;
  }

  function isExtracellularDockedNode(node, parentNode, zones) {
    if (!node || !parentNode || parentNode.shape !== "transmembrane") return false;
    const zoneMap = new Map((zones || []).map(z => [z.id, z]));
    const nZone = zoneMap.get(node.zoneId);
    const pZone = zoneMap.get(parentNode.zoneId);
    if (nZone && pZone && nZone.order < pZone.order) return true;
    const hasNoMods = !Array.isArray(node.modifications) || node.modifications.length === 0;
    if (
      hasNoMods &&
      (node.sourcePosition?.y ?? 500) < (parentNode.sourcePosition?.y ?? 500) - 12
    ) {
      return true;
    }
    return false;
  }

  function normalizeAndDeduplicateEdges(edges, validNodeIds, autoPromoteQuestionLabel = false) {
    const seen = new Set();
    const cleaned = [];
    (Array.isArray(edges) ? edges : []).forEach((e, idx) => {
      if (!e || typeof e !== "object") return;
      const source = String(e.source || e.from || "").trim();
      const target = String(e.target || e.to || "").trim();
      if (!source || !target || source === target) return;
      if (!validNodeIds.has(source) || !validNodeIds.has(target)) return;

      let rawLabel = String(e.label ?? "").trim();
      const rawType = String(e.type || e.interaction || "activates").trim();
      let normType = VALID_EDGE_TYPES.has(rawType) ? rawType : "activates";

      if (autoPromoteQuestionLabel && rawLabel === "?" && normType !== "inhibits") {
        normType = "uncertain";
      }
      if (normType === "uncertain" && !rawLabel) {
        rawLabel = "?";
      }

      const sig = `${source}->${target}`;
      if (seen.has(sig)) return;
      seen.add(sig);

      cleaned.push({
        id: String(e.id || `e_${idx}_${Date.now()}`).trim(),
        source,
        target,
        type: normType,
        label: rawLabel
      });
    });
    return cleaned;
  }

  function validateGraphReferences(graph) {
    if (!graph || !Array.isArray(graph.nodes)) return graph;
    const validZoneIds = new Set((graph.zones || []).map(z => z.id));
    const fallbackZone = (
      graph.zones?.find(z => z.visualStyle === "open_region") ||
      graph.zones?.[0] || { id: "zone_0" }
    ).id;

    const validNodeIds = new Set(graph.nodes.map(n => n.id));
    graph.nodes.forEach(n => {
      if (!validZoneIds.has(n.zoneId)) n.zoneId = fallbackZone;
      if (n.dockedTo && (!validNodeIds.has(n.dockedTo) || n.dockedTo === n.id)) {
        n.dockedTo = null;
      }
    });

    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
    graph.nodes.forEach(n => {
      if (n.dockedTo) {
        const p = nodeMap.get(n.dockedTo);
        if (p && p.dockedTo === n.id) p.dockedTo = null;
      }
    });

    graph.edges.forEach(e => {
      const s = nodeMap.get(e.source);
      const t = nodeMap.get(e.target);
      if (!s || !t) return;

      if (t.dockedTo === s.id) {
        const otherIn = graph.edges.filter(other => other.target === t.id && other.source !== s.id);
        if (otherIn.length > 0 || s.shape !== "transmembrane") {
          t.dockedTo = null;
        }
      } else if (t.dockedTo && s.shape === "transmembrane" && t.dockedTo !== s.id) {
        t.dockedTo = null;
      }
    });

    graph.edges = (graph.edges || []).filter(e => {
      const s = nodeMap.get(e.source);
      const t = nodeMap.get(e.target);
      if (!s || !t) return false;
      if (s.dockedTo === t.id || t.dockedTo === s.id) return false;
      return true;
    });

    graph.edges = normalizeAndDeduplicateEdges(graph.edges, validNodeIds, false);
    return graph;
  }

  function compileRawGraph(raw) {
    if (!raw || typeof raw !== "object") {
      throw new Error("Invalid graph state object.");
    }
    if (!Array.isArray(raw.zones) || raw.zones.length === 0) {
      raw.zones = [
        { id: "zone_membrane", label: "Membrane", order: 0, visualStyle: "membrane_bilayer" },
        { id: "zone_interior", label: "Intracellular Region", order: 1, visualStyle: "open_region" }
      ];
    }

    const seenZoneIds = new Set();
    raw.zones = raw.zones
      .filter(z => z && typeof z === "object")
      .map((z, idx) => {
        let zid = String(z.id || `zone_${idx}`).trim() || `zone_${idx}`;
        while (seenZoneIds.has(zid)) zid = `${zid}_${idx}`;
        seenZoneIds.add(zid);
        return {
          id: zid,
          label: String(z.label || `Zone ${idx + 1}`).trim(),
          order: Number.isFinite(Number(z.order)) ? Number(z.order) : idx,
          visualStyle: VALID_ZONE_STYLES.has(z.visualStyle) ? z.visualStyle : "open_region",
          topY: z.topY,
          bottomY: z.bottomY,
          bilayerY: z.bilayerY
        };
      });

    raw.zones.sort((a, b) => a.order - b.order).forEach((z, idx) => {
      z.order = idx;
    });

    if (Array.isArray(raw.legend) && raw.legend.length > 0) {
      raw.legend = raw.legend
        .filter(l => l && String(l.label || "").trim())
        .map(l => ({
          label: String(l.label).trim(),
          fillColor: /^#[0-9A-Fa-f]{6}$/.test(l.fillColor || "") ? l.fillColor : "#e0f2fe",
          borderColor: /^#[0-9A-Fa-f]{6}$/.test(l.borderColor || "") ? l.borderColor : "#334155"
        }));
      const uniqueColors = new Set(raw.legend.map(l => l.fillColor.toLowerCase()));
      if (uniqueColors.size <= 1) raw.legend = [];
    } else {
      raw.legend = [];
    }

    const defaultZoneId = (
      raw.zones.find(z => z.visualStyle === "open_region") ||
      raw.zones[0]
    ).id;

    const seenNodeIds = new Set();
    raw.nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
      .filter(n => {
        if (!n || typeof n !== "object") return false;
        const lbl = String(n.label ?? "").trim();
        return lbl.length > 0 && lbl.toLowerCase() !== "undefined" && lbl.toLowerCase() !== "null";
      })
      .map((n, idx) => {
        const rawId = String(n.id || `node_${idx}`).trim() || `node_${idx}`;
        let uniqueId = rawId;
        let suffix = 2;
        while (seenNodeIds.has(uniqueId)) {
          uniqueId = `${rawId}_${suffix++}`;
        }
        seenNodeIds.add(uniqueId);

        const cleanLabel = String(n.label).trim();
        const cleanSubs = normalizeSubunits(cleanLabel, n.subunits);

        const srcX = Number.isFinite(Number(n.sourcePosition?.x))
          ? Math.max(0, Math.min(1000, Number(n.sourcePosition.x)))
          : Number.isFinite(Number(n.origX))
          ? Math.max(0, Math.min(1000, Number(n.origX)))
          : Array.isArray(n.pos) && Number.isFinite(Number(n.pos[0]))
          ? Math.max(0, Math.min(1000, Number(n.pos[0])))
          : 150 + (idx % 5) * 170;

        const srcY = Number.isFinite(Number(n.sourcePosition?.y))
          ? Math.max(0, Math.min(1000, Number(n.sourcePosition.y)))
          : Number.isFinite(Number(n.origY))
          ? Math.max(0, Math.min(1000, Number(n.origY)))
          : Array.isArray(n.pos) && Number.isFinite(Number(n.pos[1]))
          ? Math.max(0, Math.min(1000, Number(n.pos[1])))
          : 160 + Math.floor(idx / 5) * 130;

        const rawShape = String(n.shape || "").toLowerCase();
        let shape = VALID_SHAPES.has(rawShape) ? rawShape : "oval";
        if (/\bproteasome\b/i.test(cleanLabel) || rawShape === "cylinder") {
          shape = "proteasome";
        } else if (
          (cleanSubs.length >= 2 || rawShape === "complex" || rawShape === "multi_subunit_cluster") &&
          shape !== "transmembrane"
        ) {
          shape = "multi_subunit_cluster";
        } else if (rawShape === "rectangle" || rawShape === "rounded_rectangle") {
          shape = "pill";
        }

        const resolvedZ = resolveZoneId(n.zoneId, raw) || defaultZoneId;
        const rawMods = Array.isArray(n.modifications)
          ? n.modifications
          : Array.isArray(n.badges)
          ? n.badges
          : [];

        return {
          id: uniqueId,
          label: cleanLabel,
          subunits: cleanSubs,
          dockedTo: n.dockedTo ? String(n.dockedTo).trim() : null,
          modifications: Array.from(new Set(rawMods.map(normalizeModBadge).filter(Boolean))),
          zoneId: resolvedZ,
          shape,
          fillColor: /^#[0-9A-Fa-f]{6}$/.test(n.fillColor || "") ? n.fillColor : "#e0f2fe",
          borderColor: /^#[0-9A-Fa-f]{6}$/.test(n.borderColor || "") ? n.borderColor : "#334155",
          description: String(n.description || cleanLabel).trim(),
          sourcePosition: { x: srcX, y: srcY },
          editorPosition: { x: srcX, y: srcY },
          layout: { mode: "source", pinned: false },
          origX: srcX,
          origY: srcY,
          x: srcX,
          y: srcY,
          pinned: false
        };
      });

    raw.edges = Array.isArray(raw.edges) ? raw.edges : [];

    const exactIdSet = new Set(raw.nodes.map(n => n.id));
    raw.edges.forEach(e => {
      if (!e || typeof e !== "object") return;
      const rawS = String(e.source || e.from || "").trim();
      const rawT = String(e.target || e.to || "").trim();
      if (exactIdSet.has(rawS) && exactIdSet.has(rawT)) {
        e.source = rawS;
        e.target = rawT;
        return;
      }
      const { s, t } = resolveEdgeEndpoints(rawS, rawT, [], raw);
      if (s && t) {
        e.source = s.id;
        e.target = t.id;
      }
    });

    const modifierNodes = raw.nodes.filter(isStandaloneModifierNode);
    if (modifierNodes.length > 0) {
      const modIds = new Set(modifierNodes.map(m => m.id));
      const nonModNodes = raw.nodes.filter(n => !modIds.has(n.id));

      modifierNodes.forEach(modNode => {
        const badge = normalizeModBadge(modNode.label);
        if (!badge) return;
        const connectedIds = raw.edges
          .filter(e => e.source === modNode.id || e.target === modNode.id)
          .map(e => (e.source === modNode.id ? e.target : e.source));
        let localHosts = nonModNodes.filter(
          n => connectedIds.includes(n.id) && sourceDistance(n, modNode) < 260
        );
        if (localHosts.length === 0 && nonModNodes.length > 0) {
          const nearest = [...nonModNodes].sort(
            (a, b) => sourceDistance(a, modNode) - sourceDistance(b, modNode)
          )[0];
          if (nearest && sourceDistance(nearest, modNode) < 120) {
            localHosts = [nearest];
          }
        }
        localHosts.forEach(host => {
          if (!host.modifications.includes(badge)) host.modifications.push(badge);
        });
      });

      raw.nodes = nonModNodes;
      raw.edges = raw.edges.filter(e => !modIds.has(e.source) && !modIds.has(e.target));
    }

    raw.nodes.forEach(n => {
      if (!n.dockedTo) return;
      const resolvedParent = resolveNode(n.dockedTo, [], n.id, raw, n);
      if (resolvedParent && resolvedParent.id !== n.id) {
        n.dockedTo = resolvedParent.id;
      } else {
        n.dockedTo = null;
      }
    });

    validateGraphReferences(raw);
    const validNodeIds = new Set(raw.nodes.map(n => n.id));
    raw.edges = normalizeAndDeduplicateEdges(raw.edges, validNodeIds, true);

    raw.layoutMode = "source";
    if (!Array.isArray(raw.changelog)) raw.changelog = [];
    if (!Array.isArray(raw.issues)) raw.issues = [];

    return raw;
  }

  function buildReadablePass2Checklist(graph) {
    if (!graph || !Array.isArray(graph.zones)) return "";
    const nodeMap = new Map((graph.nodes || []).map(n => [n.id, n]));
    const edges = graph.edges || [];
    const lines = [];

    graph.zones.forEach(z => {
      lines.push(
        `COMPARTMENT: "${z.label}" (id: "${z.id}", visualStyle: "${z.visualStyle}")`
      );
      const zNodes = (graph.nodes || []).filter(n => n.zoneId === z.id);
      if (zNodes.length === 0) {
        lines.push(`  (No nodes assigned to this compartment)`);
      } else {
        zNodes.forEach(n => {
          const dockedKids = (graph.nodes || [])
            .filter(c => c.dockedTo === n.id)
            .map(c => `${c.label} (id: "${c.id}")`);
          const inArrows = edges
            .filter(e => e.target === n.id)
            .map(e => {
              const s = nodeMap.get(e.source);
              return `${s ? s.label : e.source} (id: "${e.source}") --[${e.type}${e.label ? ` "${e.label}"` : ""}]--> ${n.label}`;
            });
          const outArrows = edges
            .filter(e => e.source === n.id)
            .map(e => {
              const t = nodeMap.get(e.target);
              return `${n.label} --[${e.type}${e.label ? ` "${e.label}"` : ""}]--> ${t ? t.label : e.target} (id: "${e.target}")`;
            });

          lines.push(
            `  - [${n.label}] (id: "${n.id}", shape: "${n.shape}", subunits: [${(n.subunits || []).join(", ")}], dockedTo: ${
              n.dockedTo ? `"${n.dockedTo}"` : "none"
            }, badges: [${(n.modifications || []).join(", ")}], pos: ${n.sourcePosition.x},${n.sourcePosition.y})`
          );
          if (dockedKids.length > 0) {
            lines.push(`      Docked subunits touching this node (${dockedKids.length}): ${dockedKids.join(", ")}`);
          }
          lines.push(
            `      Incoming arrows: ${inArrows.length > 0 ? inArrows.join(" ; ") : "none"}`
          );
          lines.push(
            `      Outgoing arrows: ${outArrows.length > 0 ? outArrows.join(" ; ") : "none"}`
          );
        });
      }
      lines.push("");
    });

    return lines.join("\n");
  }

  function validateAndSanitizeIssues(rawIssues, currentGraph) {
    if (!Array.isArray(rawIssues) || !currentGraph) return [];
    const validated = [];

    rawIssues.forEach((iss, i) => {
      if (!iss || typeof iss !== "object") return;
      const patch = iss.patch && typeof iss.patch === "object" ? iss.patch : {};

      const cleanUpsertNodes = (Array.isArray(patch.upsertNodes) ? patch.upsertNodes : []).filter(u => {
        if (!u || typeof u !== "object") return false;
        const lbl = String(u.label || "").trim();
        if (!lbl || lbl.length < 2) return false;
        const isExisting = currentGraph.nodes.some(
          n => n.id === u.id || n.label.toLowerCase() === lbl.toLowerCase()
        );
        if (!isExisting && PLACEHOLDER_LABEL_REGEX.test(lbl)) {
          return false;
        }
        return true;
      });

      const cleanRemoveNodeIds = (Array.isArray(patch.removeNodeIds) ? patch.removeNodeIds : []).filter(
        id => Boolean(resolveNode(id, iss.targetNodeIds, null, currentGraph))
      );

      const cleanUpsertEdges = (Array.isArray(patch.upsertEdges) ? patch.upsertEdges : [])
        .map(ed => {
          if (!ed || typeof ed !== "object") return null;
          return {
            ...ed,
            source: ed.source || ed.from,
            target: ed.target || ed.to,
            type: ed.type || ed.interaction || "activates"
          };
        })
        .filter(ed => {
          if (!ed || !ed.source || !ed.target || ed.source === ed.target) return false;
          const sExists =
            resolveNode(ed.source, iss.targetNodeIds, null, currentGraph) ||
            cleanUpsertNodes.some(
              u => u.id === ed.source || String(u.label || "").toLowerCase() === String(ed.source).toLowerCase()
            );
          const tExists =
            resolveNode(ed.target, iss.targetNodeIds, null, currentGraph) ||
            cleanUpsertNodes.some(
              u => u.id === ed.target || String(u.label || "").toLowerCase() === String(ed.target).toLowerCase()
            );
          return Boolean(sExists && tExists);
        });

      const cleanRemoveEdges = (Array.isArray(patch.removeEdges) ? patch.removeEdges : [])
        .map(ed => {
          if (!ed || typeof ed !== "object") return null;
          return {
            ...ed,
            source: ed.source || ed.from,
            target: ed.target || ed.to
          };
        })
        .filter(ed => {
          if (!ed || !ed.source || !ed.target) return false;
          const { s, t } = resolveEdgeEndpoints(ed.source, ed.target, iss.targetNodeIds, currentGraph);
          return Boolean(s && t);
        });

      const isCondense =
        Boolean(patch.condenseStates) &&
        Array.isArray(iss.targetNodeIds) &&
        iss.targetNodeIds.length >= 2;

      const hasValidExecutableAction =
        cleanUpsertNodes.length > 0 ||
        cleanRemoveNodeIds.length > 0 ||
        cleanUpsertEdges.length > 0 ||
        cleanRemoveEdges.length > 0 ||
        isCondense;

      if (!hasValidExecutableAction) return;

      validated.push({
        id: `rev_${Date.now()}_${i}`,
        category: [
          "biological_plausibility",
          "state_transition_choice",
          "nomenclature_or_visual"
        ].includes(iss.category)
          ? iss.category
          : "biological_plausibility",
        title: String(iss.title || `Review Item #${validated.length + 1}`).trim(),
        targetNodeIds: Array.isArray(iss.targetNodeIds) ? iss.targetNodeIds.map(String) : [],
        problemDescription: String(iss.problemDescription || "").trim(),
        proposedFixRationale: String(iss.proposedFixRationale || "").trim(),
        status: "pending",
        patch: {
          upsertNodes: cleanUpsertNodes,
          removeNodeIds: cleanRemoveNodeIds,
          mergeIntoId: patch.mergeIntoId || "",
          condenseStates: isCondense,
          upsertEdges: cleanUpsertEdges,
          removeEdges: cleanRemoveEdges
        }
      });
    });

    return validated;
  }

  // ============================================================================
  // 3. TRANSACTIONAL STATE PATCH REDUCER
  // ============================================================================
  function inferCanonicalZoneAndShape(nodeSpec, targetGraph = state) {
    if (!targetGraph || !Array.isArray(targetGraph.zones) || targetGraph.zones.length === 0) {
      return { zoneId: "zone_0", shape: nodeSpec?.shape || "oval" };
    }
    const explicitZone = resolveZoneId(nodeSpec?.zoneId, targetGraph);
    const memZone = targetGraph.zones.find(z => z.visualStyle === "membrane_bilayer");
    const openZone =
      targetGraph.zones.find(
        z => z.visualStyle === "open_region" && (!memZone || z.order > memZone.order)
      ) ||
      targetGraph.zones.find(z => z.visualStyle === "open_region") ||
      targetGraph.zones[0];
    const enclosedZone = targetGraph.zones.find(z => z.visualStyle === "enclosed_organelle");

    const normShape = VALID_SHAPES.has(nodeSpec?.shape)
      ? nodeSpec.shape
      : Array.isArray(nodeSpec?.subunits) && nodeSpec.subunits.length >= 2
      ? "multi_subunit_cluster"
      : "oval";

    if (explicitZone) {
      return { zoneId: explicitZone, shape: normShape };
    }
    if (normShape === "transmembrane" && memZone && !nodeSpec?.dockedTo) {
      return { zoneId: memZone.id, shape: "transmembrane" };
    }
    if (enclosedZone && (normShape === "dna_target" || normShape === "banner")) {
      return { zoneId: enclosedZone.id, shape: normShape };
    }
    return { zoneId: openZone.id, shape: normShape };
  }

  function validatePatchObject(patch) {
    if (!patch || typeof patch !== "object") {
      throw new Error("Patch must be a valid JSON object.");
    }
    const arrayKeys = ["upsertNodes", "removeNodeIds", "upsertEdges", "removeEdges"];
    for (const k of arrayKeys) {
      if (patch[k] !== undefined && !Array.isArray(patch[k])) {
        throw new Error(`Patch field '${k}' must be an array.`);
      }
    }
  }

  function applyPatch(patch, sourceTitle = "Update", fallbackTargetIds = [], options = {}) {
    if (!state) return false;
    validatePatchObject(patch);

    const workingState = JSON.parse(JSON.stringify(state));
    const summaryParts = [];
    const rejectedParts = [];
    const newlyInsertedNodeIds = [];

    if (Array.isArray(patch.convertEdgesToDocking)) {
      patch.convertEdgesToDocking.forEach(conv => {
        if (!conv) return;
        const { s: parent, t: child } = resolveEdgeEndpoints(
          conv.parent || conv.source,
          conv.child || conv.target,
          fallbackTargetIds,
          workingState
        );
        if (parent && child && parent.id !== child.id) {
          child.dockedTo = parent.id;
          workingState.edges = workingState.edges.filter(
            e =>
              !((e.source === parent.id && e.target === child.id) ||
                (e.source === child.id && e.target === parent.id))
          );
          summaryParts.push(`docked '${child.label}' to '${parent.label}'`);
        }
      });
    }

    (patch.removeEdges || []).forEach(rem => {
      if (!rem) return;
      const rawS = rem.source || rem.from;
      const rawT = rem.target || rem.to;
      const { s, t } = resolveEdgeEndpoints(rawS, rawT, fallbackTargetIds, workingState);
      if (s && t) {
        const before = workingState.edges.length;
        workingState.edges = workingState.edges.filter(
          e => !(e.source === s.id && e.target === t.id)
        );
        if (workingState.edges.length < before) {
          summaryParts.push(`removed arrow ${s.label} → ${t.label}`);
        }
      } else {
        rejectedParts.push(`unresolved edge removal (${rawS} → ${rawT})`);
      }
    });

    (patch.upsertNodes || []).forEach((u, idx) => {
      if (!u || typeof u !== "object") return;
      const exactIdMatch = u.id
        ? workingState.nodes.find(
            n => n.id === u.id || n.id.toLowerCase() === String(u.id).toLowerCase()
          )
        : null;
      const exactLblMatches = u.label
        ? workingState.nodes.filter(
            n => n.label.toLowerCase() === String(u.label).trim().toLowerCase()
          )
        : [];
      const uniqueLabelMatch = exactLblMatches.length === 1 ? exactLblMatches[0] : null;
      const fallbackMatch =
        !exactIdMatch &&
        !uniqueLabelMatch &&
        patch.upsertNodes.length === 1 &&
        (!patch.upsertEdges || patch.upsertEdges.length === 0)
          ? resolveNode(u.id || u.targetNodeId, fallbackTargetIds, null, workingState)
          : null;

      const target = exactIdMatch || uniqueLabelMatch || fallbackMatch;

      if (target) {
        if (
          u.label &&
          String(u.label).trim() &&
          String(u.label).toLowerCase() !== "undefined"
        ) {
          const oldLbl = target.label;
          target.label = String(u.label).trim();
          if (oldLbl !== target.label) {
            summaryParts.push(`renamed '${oldLbl}' to '${target.label}'`);
          }
        }
        if (Array.isArray(u.subunits)) {
          target.subunits = normalizeSubunits(target.label, u.subunits);
          if (target.subunits.length >= 2 && target.shape === "oval") {
            target.shape = "multi_subunit_cluster";
          }
          summaryParts.push(`updated '${target.label}' subunits`);
        } else {
          target.subunits = normalizeSubunits(target.label, target.subunits);
        }
        if (u.dockedTo !== undefined) {
          const resolvedDock = u.dockedTo
            ? resolveNode(u.dockedTo, [], target.id, workingState, target)
            : null;
          target.dockedTo = resolvedDock ? resolvedDock.id : null;
        }
        const incomingMods = Array.isArray(u.modifications)
          ? u.modifications
          : Array.isArray(u.badges)
          ? u.badges
          : null;
        if (incomingMods) {
          target.modifications = incomingMods.map(normalizeModBadge).filter(Boolean);
          summaryParts.push(
            `updated '${target.label}' badges to [${target.modifications.join(", ") || "none"}]`
          );
        }
        if (u.shape && VALID_SHAPES.has(u.shape)) target.shape = u.shape;
        const resolvedZ = resolveZoneId(u.zoneId, workingState);
        if (resolvedZ && resolvedZ !== target.zoneId) {
          target.zoneId = resolvedZ;
          summaryParts.push(`moved '${target.label}' to ${resolvedZ}`);
        }
        if (u.fillColor && /^#[0-9A-Fa-f]{6}$/.test(u.fillColor)) {
          target.fillColor = u.fillColor;
        }
        const posX = Number.isFinite(Number(u.origX))
          ? Number(u.origX)
          : Array.isArray(u.pos) && Number.isFinite(Number(u.pos[0]))
          ? Number(u.pos[0])
          : null;
        const posY = Number.isFinite(Number(u.origY))
          ? Number(u.origY)
          : Array.isArray(u.pos) && Number.isFinite(Number(u.pos[1]))
          ? Number(u.pos[1])
          : null;

        if (posX !== null) {
          target.origX = posX;
          target.sourcePosition = {
            x: posX,
            y: target.sourcePosition?.y ?? target.origY
          };
        }
        if (posY !== null) {
          target.origY = posY;
          target.sourcePosition = {
            x: target.sourcePosition?.x ?? target.origX,
            y: posY
          };
        }
      } else if (u.label && String(u.label).trim()) {
        const cleanLabel = String(u.label).trim();
        if (PLACEHOLDER_LABEL_REGEX.test(cleanLabel)) {
          rejectedParts.push(`rejected placeholder node '${cleanLabel}'`);
          return;
        }
        const baseId = u.id ? String(u.id).trim() : `node_${Date.now()}_${idx}`;
        let newId = baseId;
        let suffix = 2;
        while (workingState.nodes.some(n => n.id.toLowerCase() === newId.toLowerCase())) {
          newId = `${baseId}_${suffix++}`;
        }

        const cleanSubs = normalizeSubunits(cleanLabel, u.subunits);
        const inferred = inferCanonicalZoneAndShape({ ...u, subunits: cleanSubs }, workingState);
        const initX = Number.isFinite(Number(u.origX))
          ? Number(u.origX)
          : Array.isArray(u.pos) && Number.isFinite(Number(u.pos[0]))
          ? Number(u.pos[0])
          : 500;
        const initY = Number.isFinite(Number(u.origY))
          ? Number(u.origY)
          : Array.isArray(u.pos) && Number.isFinite(Number(u.pos[1]))
          ? Number(u.pos[1])
          : 350;

        const dummyAnchor = { sourcePosition: { x: initX, y: initY }, origX: initX, origY: initY };
        const resolvedDock = u.dockedTo
          ? resolveNode(u.dockedTo, [], newId, workingState, dummyAnchor)
          : null;
        const rawMods = Array.isArray(u.modifications)
          ? u.modifications
          : Array.isArray(u.badges)
          ? u.badges
          : [];

        const newNode = {
          id: newId,
          label: cleanLabel,
          subunits: cleanSubs,
          dockedTo: resolvedDock ? resolvedDock.id : null,
          modifications: rawMods.map(normalizeModBadge).filter(Boolean),
          zoneId: inferred.zoneId,
          shape: inferred.shape,
          fillColor: /^#[0-9A-Fa-f]{6}$/.test(u.fillColor || "") ? u.fillColor : "#e0f2fe",
          borderColor: /^#[0-9A-Fa-f]{6}$/.test(u.borderColor || "") ? u.borderColor : "#0284c7",
          description: String(u.description || `Signaling element ${cleanLabel}.`).trim(),
          sourcePosition: { x: initX, y: initY },
          editorPosition: { x: 500, y: 300 },
          layout: { mode: "source", pinned: false },
          origX: initX,
          origY: initY,
          x: 500,
          y: 300,
          pinned: false
        };
        workingState.nodes.push(newNode);
        newlyInsertedNodeIds.push(newId);
        summaryParts.push(`added '${newNode.label}'`);
      } else {
        rejectedParts.push("ignored node upsert with missing label");
      }
    });

    const removeList = Array.isArray(patch.removeNodeIds) ? [...patch.removeNodeIds] : [];
    let keepNode = patch.mergeIntoId
      ? resolveNode(patch.mergeIntoId, fallbackTargetIds, null, workingState)
      : null;

    if (!keepNode && removeList.length === 0 && fallbackTargetIds.length >= 2 && patch.condenseStates) {
      const n1 = resolveNode(fallbackTargetIds[0], [], null, workingState);
      const n2 = resolveNode(fallbackTargetIds[1], [], n1?.id, workingState, n1);
      if (n1 && n2) {
        keepNode = (n2.modifications?.length || 0) >= (n1.modifications?.length || 0) ? n2 : n1;
        const dropNode = keepNode.id === n2.id ? n1 : n2;
        removeList.push(dropNode.id);
      }
    }

    if (removeList.length > 0) {
      const resolvedRemoveIds = removeList
        .map(id => resolveNode(id, fallbackTargetIds, keepNode?.id, workingState, keepNode)?.id)
        .filter(id => id && (!keepNode || id !== keepNode.id));
      const removeSet = new Set(resolvedRemoveIds);

      if (removeSet.size > 0) {
        if (keepNode) {
          workingState.edges.forEach(e => {
            if (removeSet.has(e.source)) e.source = keepNode.id;
            if (removeSet.has(e.target)) e.target = keepNode.id;
          });
          summaryParts.push(`condensed [${Array.from(removeSet).join(", ")}] into '${keepNode.label}'`);
        } else {
          summaryParts.push(`removed [${Array.from(removeSet).join(", ")}]`);
        }
        workingState.nodes = workingState.nodes.filter(n => !removeSet.has(n.id));
        workingState.edges = workingState.edges.filter(
          e => !removeSet.has(e.source) && !removeSet.has(e.target) && e.source !== e.target
        );
      }
    }

    (patch.upsertEdges || []).forEach(ed => {
      if (!ed) return;
      const rawS = ed.source || ed.from;
      const rawT = ed.target || ed.to;
      const { s, t } = resolveEdgeEndpoints(rawS, rawT, fallbackTargetIds, workingState);
      if (s && t && s.id !== t.id) {
        const existing = workingState.edges.find(e => e.source === s.id && e.target === t.id);
        const rawType = String(ed.type || ed.interaction || "activates").trim();
        let validType = VALID_EDGE_TYPES.has(rawType) ? rawType : "activates";
        let explicitLabel =
          ed.label !== undefined
            ? String(ed.label).trim()
            : validType === "uncertain"
            ? "?"
            : "";

        if (existing) {
          if (
            options.isAutomatedVerifier &&
            (existing.label === "?" || existing.type === "uncertain") &&
            !explicitLabel
          ) {
            explicitLabel = existing.label || "?";
            if (existing.type === "uncertain") validType = "uncertain";
          }
          existing.type = validType;
          existing.label = explicitLabel;
          summaryParts.push(`set ${s.label} → ${t.label} to '${validType}'`);
        } else {
          if (explicitLabel === "?" && validType !== "inhibits") {
            validType = "uncertain";
          }
          workingState.edges.push({
            id: `e_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            source: s.id,
            target: t.id,
            type: validType,
            label: explicitLabel
          });
          summaryParts.push(`connected ${s.label} (${validType}) → ${t.label}`);
        }
      } else {
        rejectedParts.push(`unresolved edge (${rawS} → ${rawT})`);
      }
    });

    if (newlyInsertedNodeIds.length > 0) {
      const newSet = new Set(newlyInsertedNodeIds);
      const upstreamAnchors = workingState.edges
        .filter(e => newSet.has(e.target) && !newSet.has(e.source))
        .map(e => workingState.nodes.find(n => n.id === e.source))
        .filter(Boolean);
      const downstreamTargets = workingState.edges
        .filter(e => newSet.has(e.source) && !newSet.has(e.target))
        .map(e => workingState.nodes.find(n => n.id === e.target))
        .filter(Boolean);

      upstreamAnchors.forEach(up => {
        downstreamTargets.forEach(down => {
          workingState.edges = workingState.edges.filter(
            e => !(e.source === up.id && e.target === down.id)
          );
        });
      });

      const anchorUp = upstreamAnchors[0] || downstreamTargets[0];
      const anchorDown = downstreamTargets[0] || upstreamAnchors[0];
      const upX = anchorUp?.sourcePosition?.x ?? anchorUp?.origX ?? 500;
      const downX = anchorDown?.sourcePosition?.x ?? anchorDown?.origX ?? upX;
      const upY = anchorUp?.sourcePosition?.y ?? anchorUp?.origY ?? 200;
      const downY = anchorDown?.sourcePosition?.y ?? anchorDown?.origY ?? Math.min(850, upY + 260);

      const orderedChain = [];
      const visited = new Set();
      const visit = id => {
        if (visited.has(id) || !newSet.has(id)) return;
        visited.add(id);
        workingState.edges
          .filter(e => e.target === id && newSet.has(e.source))
          .forEach(e => visit(e.source));
        orderedChain.push(id);
        workingState.edges
          .filter(e => e.source === id && newSet.has(e.target))
          .forEach(e => visit(e.target));
      };
      newlyInsertedNodeIds.forEach(visit);

      const hasMembraneNode = orderedChain.some(id => {
        const nd = workingState.nodes.find(n => n.id === id);
        const z = workingState.zones.find(zn => zn.id === nd?.zoneId);
        return z?.visualStyle === "membrane_bilayer";
      });

      const laneX = hasMembraneNode
        ? Math.min(920, Math.max(upX, downX) + 110)
        : Math.round((upX + downX) / 2);

      orderedChain.forEach((id, idx) => {
        const nd = workingState.nodes.find(n => n.id === id);
        if (!nd) return;
        const z = workingState.zones.find(zn => zn.id === nd.zoneId);
        const frac = (idx + 1) / (orderedChain.length + 1);
        const interpY =
          z?.visualStyle === "membrane_bilayer"
            ? 95
            : Math.round(Math.min(upY, downY) + frac * Math.max(140, Math.abs(downY - upY)));
        nd.sourcePosition = { x: laneX, y: interpY };
        nd.origX = laneX;
        nd.origY = interpY;
      });
    }

    if (patch.normalizeAllModifications) {
      workingState.nodes.forEach(n => {
        n.modifications = (n.modifications || []).map(normalizeModBadge).filter(Boolean);
      });
      summaryParts.push("standardized modification badges to canonical symbols (P, ub)");
    }

    validateGraphReferences(workingState);

    if (!options.skipUndo) {
      pushUndoSnapshot();
    }
    state = workingState;
    computeLayout({ preservePinned: true });

    const finalMsgParts = [...summaryParts];
    if (rejectedParts.length > 0) {
      finalMsgParts.push(`skipped: ${rejectedParts.join(", ")}`);
    }
    appendChangelog(
      sourceTitle,
      finalMsgParts.length > 0
        ? finalMsgParts.join("; ") + "."
        : "Verified pathway state (no structural mutations required)."
    );
    if (!options.skipRender) {
      renderAll();
    }
    return true;
  }

  function appendChangelog(source, message) {
    if (!state) return;
    if (!Array.isArray(state.changelog)) state.changelog = [];
    state.changelog.unshift({
      time: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }),
      source: String(source || "System"),
      message: String(message || "")
    });
  }

  // ============================================================================
  // 4. TOPOLOGY-DRIVEN 2D MULTI-TIER LAYOUT ENGINE
  // ============================================================================
  function computeNodeDimensions(node) {
    const primaryLen = (node.label || "").length;
    const cleanSubs = normalizeSubunits(node.label, node.subunits);
    const hasSubs = cleanSubs.length >= 2;

    if (node.shape === "banner") {
      return { width: Math.max(175, primaryLen * 8.2 + 44), height: 42 };
    }
    if (node.shape === "transmembrane") {
      return {
        width: Math.max(134, Math.min(230, primaryLen * 7.4 + 32)),
        height: 74
      };
    }
    if (node.shape === "proteasome") {
      return { width: Math.max(105, primaryLen * 7.5 + 28), height: 64 };
    }
    if (hasSubs) {
      const subWidths = cleanSubs.map(s => Math.max(54, s.length * 7.2 + 18));
      const totalSubW = subWidths.reduce((a, b) => a + b, 0) + (cleanSubs.length - 1) * 4 + 14;
      return {
        width: Math.max(116, Math.min(240, totalSubW)),
        height: 44
      };
    }
    return { width: Math.max(88, Math.min(185, primaryLen * 7.6 + 28)), height: 38 };
  }

  function getEffectiveComplexWidth(parentNode, allNodes) {
    const kids = allNodes.filter(
      n =>
        n.dockedTo === parentNode.id &&
        !isExtracellularDockedNode(n, parentNode, state?.zones)
    );
    if (kids.length <= 1) return parentNode.w;
    kids.sort((a, b) => a.sourcePosition.y - b.sourcePosition.y);
    const tiers = [];
    kids.forEach(k => {
      const last = tiers[tiers.length - 1];
      if (!last || Math.abs(k.sourcePosition.y - last.refY) > 22) {
        tiers.push({ refY: k.sourcePosition.y, items: [k] });
      } else {
        last.items.push(k);
      }
    });
    const maxTierW = Math.max(
      ...tiers.map(t => t.items.reduce((sum, k) => sum + (k.w || 95), 0))
    );
    return Math.max(parentNode.w, maxTierW);
  }

  function resolveRowCollisions(rowNodes, minLeft, maxRight, minGap = 38, allNodes = []) {
    if (!rowNodes || rowNodes.length <= 1) return;
    const effW = n => (allNodes.length > 0 ? getEffectiveComplexWidth(n, allNodes) : n.w);

    for (let pass = 0; pass < 6; pass++) {
      for (let i = 1; i < rowNodes.length; i++) {
        const prev = rowNodes[i - 1];
        const curr = rowNodes[i];
        const minAllowed = prev.x + effW(prev) / 2 + effW(curr) / 2 + minGap;
        if (curr.x < minAllowed) {
          const overlap = minAllowed - curr.x;
          if (!prev.pinned) prev.x -= overlap * 0.45;
          if (!curr.pinned) curr.x += overlap * (prev.pinned ? 1 : 0.55);
        }
      }
      for (let i = rowNodes.length - 1; i >= 0; i--) {
        const curr = rowNodes[i];
        const cw = effW(curr);
        if (!curr.pinned && curr.x + cw / 2 > maxRight) curr.x = maxRight - cw / 2;
        if (i > 0) {
          const prev = rowNodes[i - 1];
          const maxPrev = curr.x - cw / 2 - effW(prev) / 2 - minGap;
          if (!prev.pinned && prev.x > maxPrev) prev.x = maxPrev;
        }
      }
      let leftCursor = minLeft;
      for (let i = 0; i < rowNodes.length; i++) {
        const curr = rowNodes[i];
        const cw = effW(curr);
        if (!curr.pinned && curr.x - cw / 2 < leftCursor) curr.x = leftCursor + cw / 2;
        leftCursor = curr.x + cw / 2 + minGap;
      }
    }
  }

  function snapDockedComplexes(nodeMap) {
    const childrenByParent = new Map();
    state.nodes.forEach(n => {
      if (!n.dockedTo || n.pinned) return;
      const p = nodeMap.get(n.dockedTo);
      if (!p) return;
      if (!childrenByParent.has(p.id)) childrenByParent.set(p.id, []);
      childrenByParent.get(p.id).push(n);
    });

    const sortedParents = Array.from(childrenByParent.keys())
      .map(id => nodeMap.get(id))
      .filter(Boolean)
      .sort((a, b) => a.y - b.y);

    sortedParents.forEach(parent => {
      const allKids = childrenByParent.get(parent.id) || [];
      const extraKids = allKids.filter(k =>
        isExtracellularDockedNode(k, parent, state.zones)
      );
      const intraKids = allKids.filter(
        k => !isExtracellularDockedNode(k, parent, state.zones)
      );

      if (extraKids.length > 0) {
        extraKids.sort((a, b) => a.sourcePosition.x - b.sourcePosition.x);
        const topY = parent.y - 48;
        const totalW = extraKids.reduce((s, k) => s + k.w, 0) + (extraKids.length - 1) * 6;
        let curX = Math.round(parent.x - totalW / 2);
        extraKids.forEach(k => {
          k.x = Math.round(curX + k.w / 2);
          k.y = topY;
          curX += k.w + 6;
        });
      }

      if (intraKids.length === 0) return;

      let stackBottomY =
        parent.shape === "transmembrane" ? parent.y + 25 : parent.y + parent.h / 2 - 2;

      if (intraKids.length === 1) {
        const k = intraKids[0];
        k.x = parent.x;
        k.y = Math.round(stackBottomY + k.h / 2);
        return;
      }

      intraKids.sort(
        (a, b) =>
          a.sourcePosition.y - b.sourcePosition.y || a.sourcePosition.x - b.sourcePosition.x
      );

      const tiers = [];
      intraKids.forEach(k => {
        const last = tiers[tiers.length - 1];
        if (!last || Math.abs(k.sourcePosition.y - last.refY) > 22) {
          tiers.push({ refY: k.sourcePosition.y, items: [k] });
        } else {
          last.items.push(k);
        }
      });

      tiers.forEach(tier => {
        tier.items.sort((a, b) => a.sourcePosition.x - b.sourcePosition.x);
        const rowH = Math.max(...tier.items.map(it => it.h));
        const centerY = Math.round(stackBottomY + rowH / 2 - 2);
        const overlapStep = -2;
        const totalW =
          tier.items.reduce((s, it) => s + it.w, 0) +
          (tier.items.length - 1) * overlapStep;
        let curX = Math.round(parent.x - totalW / 2);
        tier.items.forEach(it => {
          it.x = Math.round(curX + it.w / 2);
          it.y = centerY;
          curX += it.w + overlapStep;
        });
        stackBottomY = centerY + rowH / 2;
      });
    });
  }

  function clampMaxVerticalGaps(freeNodes, minStartTopY, maxGap = MAX_VERTICAL_GAP) {
    if (!freeNodes || freeNodes.length === 0) return;
    freeNodes.sort((a, b) => a.y - b.y);

    const firstTopEdge = freeNodes[0].y - freeNodes[0].h / 2;
    if (firstTopEdge > minStartTopY + maxGap * 0.65) {
      const pullUp = Math.round(firstTopEdge - (minStartTopY + maxGap * 0.5));
      freeNodes.forEach(n => {
        if (!n.pinned) n.y -= pullUp;
      });
    } else if (firstTopEdge < minStartTopY) {
      const pushDown = Math.round(minStartTopY - firstTopEdge);
      freeNodes.forEach(n => {
        if (!n.pinned) n.y += pushDown;
      });
    }

    for (let i = 1; i < freeNodes.length; i++) {
      const prev = freeNodes[i - 1];
      const curr = freeNodes[i];
      const dy = curr.y - prev.y;
      if (dy > maxGap) {
        const excess = Math.round(dy - maxGap);
        for (let j = i; j < freeNodes.length; j++) {
          if (!freeNodes[j].pinned) {
            freeNodes[j].y -= excess;
          }
        }
      }
    }
  }

  // Straightens 1-to-1 vertical signaling columns and positions pure lateral regulators
  // without averaging converging cross-pathway X coordinates.
  function alignZoneXByTopology(freeNodes, nodeMap, minLeft, maxRight) {
    if (!freeNodes || freeNodes.length === 0) return;
    freeNodes.sort((a, b) => a.y - b.y);

    const lateralRegulators = [];
    const signalingNodes = [];

    freeNodes.forEach(n => {
      const inEdges = state.edges.filter(e => e.target === n.id);
      const outEdges = state.edges.filter(e => e.source === n.id);
      const isPureLateralInhibitor =
        inEdges.length === 0 &&
        outEdges.length > 0 &&
        outEdges.every(e => e.type === "inhibits");

      if (isPureLateralInhibitor) {
        lateralRegulators.push(n);
      } else {
        signalingNodes.push(n);
      }
    });

    signalingNodes.forEach(n => {
      if (n.pinned) return;
      const inActivating = state.edges.filter(e => {
        if (e.target !== n.id || e.type === "inhibits") return false;
        const src = nodeMap.get(e.source);
        return Boolean(src);
      });

      if (inActivating.length === 1) {
        const rawParent = nodeMap.get(inActivating[0].source);
        const parentAnchor = rawParent ? getRootDockAnchor(rawParent, nodeMap) : null;
        if (parentAnchor && parentAnchor.y < n.y - 10) {
          const srcDx = Math.abs(
            (parentAnchor.sourcePosition?.x ?? 500) - (n.sourcePosition?.x ?? 500)
          );
          const srcDy = Math.abs(
            (n.sourcePosition?.y ?? 500) - (parentAnchor.sourcePosition?.y ?? 500)
          );
          const siblingsFromParent = state.edges.filter(
            e =>
              e.type !== "inhibits" &&
              getRootDockAnchor(nodeMap.get(e.source), nodeMap)?.id === parentAnchor.id
          );
          // Snap to exact vertical column only when parent->child is a predominantly vertical 1-to-1 step
          if (siblingsFromParent.length === 1 && srcDy > srcDx) {
            n.x = parentAnchor.x;
          }
        }
      }
    });

    lateralRegulators.forEach(reg => {
      if (reg.pinned) return;
      const outEdges = state.edges.filter(e => e.source === reg.id);
      const targets = outEdges
        .map(e => nodeMap.get(e.target))
        .filter(Boolean);
      if (targets.length === 0) return;

      const primaryTarget = targets[0];
      const placeOnLeft = reg.sourcePosition.x <= primaryTarget.sourcePosition.x;
      const horizontalOffset = Math.round(primaryTarget.w / 2 + reg.w / 2 + 44);

      reg.x = placeOnLeft
        ? Math.max(minLeft + reg.w / 2, primaryTarget.x - horizontalOffset)
        : Math.min(maxRight - reg.w / 2, primaryTarget.x + horizontalOffset);

      if (reg.zoneId === primaryTarget.zoneId) {
        const coInhibitors = lateralRegulators.filter(
          other =>
            other.zoneId === reg.zoneId &&
            state.edges.some(e => e.source === other.id && e.target === primaryTarget.id)
        );
        if (coInhibitors.length === 1) {
          reg.y = primaryTarget.y;
        } else {
          const idx = coInhibitors.indexOf(reg);
          const totalSpan = (coInhibitors.length - 1) * 48;
          reg.y = Math.round(primaryTarget.y - totalSpan / 2 + idx * 48);
        }
      }
    });
  }

  function resolve2DZoneOverlaps(anchors, minLeft, maxRight, minTop, gapX = 28, gapY = 22) {
    if (!anchors || anchors.length <= 1) return;
    const effW = n => getEffectiveComplexWidth(n, state.nodes);

    for (let iter = 0; iter < 12; iter++) {
      let moved = false;
      anchors.sort((a, b) => a.y - b.y || a.x - b.x);
      for (let i = 0; i < anchors.length; i++) {
        for (let j = i + 1; j < anchors.length; j++) {
          const a = anchors[i];
          const b = anchors[j];
          const reqX = effW(a) / 2 + effW(b) / 2 + gapX;
          const reqY = a.h / 2 + b.h / 2 + gapY;
          const dx = b.x - a.x;
          const dy = b.y - a.y;

          if (Math.abs(dx) < reqX && Math.abs(dy) < reqY) {
            moved = true;
            const overlapX = reqX - Math.abs(dx);
            const overlapY = reqY - Math.abs(dy);

            // A connected pair is a vertical cascade only if its vertical displacement in the source
            // image exceeds its horizontal displacement; horizontal cascades separate along X.
            const isConnected = state.edges.some(
              e =>
                e.type !== "inhibits" &&
                ((e.source === a.id && e.target === b.id) ||
                  (e.source === b.id && e.target === a.id))
            );
            const srcDx = Math.abs((a.sourcePosition?.x ?? 500) - (b.sourcePosition?.x ?? 500));
            const srcDy = Math.abs((a.sourcePosition?.y ?? 500) - (b.sourcePosition?.y ?? 500));
            const isVerticalCascadePair = isConnected && srcDy > srcDx;

            if (!isVerticalCascadePair && (srcDx >= srcDy || overlapX < overlapY * 1.3)) {
              const dirX =
                (b.sourcePosition?.x ?? b.x) >= (a.sourcePosition?.x ?? a.x) ? 1 : -1;
              const shiftX = Math.ceil(overlapX / 2) + 2;
              if (!a.pinned) a.x -= dirX * shiftX;
              if (!b.pinned) b.x += dirX * shiftX;
            } else {
              const dirY =
                (b.sourcePosition?.y ?? b.y) >= (a.sourcePosition?.y ?? a.y) ? 1 : -1;
              const shiftY = Math.ceil(overlapY / 2) + 2;
              if (!a.pinned) a.y = Math.max(minTop, a.y - dirY * shiftY * 0.3);
              if (!b.pinned) b.y = Math.max(minTop, b.y + dirY * shiftY * 0.7);
            }
          }
        }
      }
      anchors.forEach(n => {
        if (!n.pinned) {
          const w = effW(n);
          n.x = Math.max(minLeft + w / 2, Math.min(maxRight - w / 2, Math.round(n.x)));
          n.y = Math.max(minTop + n.h / 2, Math.round(n.y));
        }
      });
      if (!moved) break;
    }
  }

  function computeLayout(options = {}) {
    if (!state) return;
    validateGraphReferences(state);

    const preservePinned = options.preservePinned !== false;
    const savedPins = new Map();

    state.nodes.forEach(n => {
      const dims = computeNodeDimensions(n);
      n.w = dims.width;
      n.h = dims.height;
      if (preservePinned && n.pinned && Number.isFinite(n.x) && Number.isFinite(n.y)) {
        savedPins.set(n.id, { x: n.x, y: n.y });
      } else {
        n.pinned = false;
        if (n.layout) n.layout.pinned = false;
      }
    });

    const nodeMap = new Map(state.nodes.map(n => [n.id, n]));
    const sortedZones = [...state.zones].sort((a, b) => a.order - b.order);

    const marginX = 95;
    let maxRowWidth = 1280;

    const memNodes = state.nodes.filter(n => n.shape === "transmembrane");
    if (memNodes.length > 0) {
      const memW =
        memNodes.reduce((s, n) => s + getEffectiveComplexWidth(n, state.nodes) + 85, 0) +
        marginX * 2;
      maxRowWidth = Math.max(maxRowWidth, memW);
    }

    const usableW = maxRowWidth - marginX * 2;
    state.nodes.forEach(n => {
      const normX = Math.max(0, Math.min(1, (n.sourcePosition?.x ?? 500) / 1000));
      n.x = Math.round(marginX + normX * usableW);
    });

    const firstMembraneOrder =
      sortedZones.find(z => z.visualStyle === "membrane_bilayer")?.order ?? 999;

    let yCursor = 65;
    sortedZones.forEach(zone => {
      const zNodes = state.nodes.filter(n => n.zoneId === zone.id);
      const isOuterOpenZone =
        zone.visualStyle === "open_region" && zone.order < firstMembraneOrder;

      const undockedOuterNodes = isOuterOpenZone
        ? zNodes.filter(n => !n.dockedTo)
        : zNodes;

      if (undockedOuterNodes.length === 0) {
        if (isOuterOpenZone) {
          zone.topY = yCursor - 25;
          zone.bottomY = yCursor - 5;
        } else {
          zone.topY = yCursor - 30;
          zone.bottomY = yCursor + 35;
          yCursor += 70;
        }
        return;
      }

      zone.topY = yCursor - 35;

      if (isOuterOpenZone) {
        const ligY = zone.topY + 42;
        undockedOuterNodes.forEach(lig => {
          lig.y = ligY;
        });
        undockedOuterNodes.sort((a, b) => a.x - b.x);
        resolveRowCollisions(undockedOuterNodes, marginX, maxRowWidth - marginX, 40, state.nodes);
        zone.bottomY = ligY + 28;
        yCursor = zone.bottomY + 38;
      } else if (zone.visualStyle === "membrane_bilayer") {
        const extNodes = zNodes.filter(n => n.shape !== "transmembrane" && !n.dockedTo);
        const recNodes = zNodes.filter(n => n.shape === "transmembrane");
        const hasDockedExtracellular = state.nodes.some(n => {
          const p = n.dockedTo ? nodeMap.get(n.dockedTo) : null;
          return p && isExtracellularDockedNode(n, p, state.zones);
        });

        zone.bilayerY =
          extNodes.length > 0 || hasDockedExtracellular ? zone.topY + 95 : zone.topY + 50;

        recNodes.sort((a, b) => a.sourcePosition.x - b.sourcePosition.x);
        if (recNodes.length === 1) {
          recNodes[0].x = Math.round(maxRowWidth / 2);
          recNodes[0].y = zone.bilayerY;
        } else if (recNodes.length > 1) {
          const totalComplexFootprint = recNodes.reduce(
            (s, r) => s + getEffectiveComplexWidth(r, state.nodes),
            0
          );
          const spanW = Math.min(
            usableW,
            Math.max(560, totalComplexFootprint + (recNodes.length - 1) * 95)
          );
          const startX = Math.round((maxRowWidth - spanW) / 2);
          recNodes.forEach((r, idx) => {
            r.x = Math.round(startX + ((idx + 0.5) / recNodes.length) * spanW);
            r.y = zone.bilayerY;
          });
          resolveRowCollisions(recNodes, marginX, maxRowWidth - marginX, 60, state.nodes);
        }

        extNodes.forEach(lig => {
          lig.y = zone.bilayerY - 56;
          const outEdge = state.edges.find(e => e.source === lig.id);
          const rec = outEdge ? nodeMap.get(outEdge.target) : null;
          if (rec) lig.x = rec.x;
        });
        extNodes.sort((a, b) => a.x - b.x);
        resolveRowCollisions(extNodes, marginX, maxRowWidth - marginX, 40, state.nodes);

        snapDockedComplexes(nodeMap);

        const maxRecHalfH = recNodes.length > 0 ? Math.max(...recNodes.map(r => r.h / 2)) : 38;
        zone.bottomY = zone.bilayerY + maxRecHalfH + 8;
        yCursor = zone.bottomY + 34;
      } else {
        const isBottomSink = n =>
          (n.shape === "banner" || n.shape === "dna_target") &&
          state.edges.filter(e => e.source === n.id).length === 0;

        const regularNodes = zNodes.filter(n => !isBottomSink(n));
        const sinkNodes = zNodes.filter(n => isBottomSink(n));

        snapDockedComplexes(nodeMap);

        const isFirstIntracellularOpenZone =
          zone.visualStyle === "open_region" && zone.order > firstMembraneOrder;

        const membraneDockedNodes = isFirstIntracellularOpenZone
          ? state.nodes.filter(n => {
              if (!n.dockedTo) return false;
              const root = getRootDockAnchor(n, nodeMap);
              return (
                root &&
                root.shape === "transmembrane" &&
                !isExtracellularDockedNode(n, root, state.zones)
              );
            })
          : [];

        const maxMembraneDockedBottomY =
          membraneDockedNodes.length > 0
            ? Math.max(...membraneDockedNodes.map(n => n.y + n.h / 2))
            : zone.topY + 20;

        const freeRegularNodes = regularNodes.filter(n => !n.dockedTo);

        if (freeRegularNodes.length > 0) {
          const srcYs = freeRegularNodes.map(n => n.sourcePosition?.y ?? 500);
          const minSrcY = Math.min(...srcYs);
          const maxSrcY = Math.max(...srcYs);
          const spanSrcY = Math.max(70, maxSrcY - minSrcY);

          const freeStartTopY = Math.max(zone.topY + 42, maxMembraneDockedBottomY + 48);
          const rawPixelSpan = Math.max(60, Math.round(spanSrcY * 0.65));

          freeRegularNodes.forEach(n => {
            const rel =
              freeRegularNodes.length === 1
                ? 0
                : ((n.sourcePosition?.y ?? minSrcY) - minSrcY) / spanSrcY;
            n.y = Math.round(freeStartTopY + rel * rawPixelSpan);
          });

          clampMaxVerticalGaps(freeRegularNodes, freeStartTopY, MAX_VERTICAL_GAP);
          alignZoneXByTopology(freeRegularNodes, nodeMap, marginX, maxRowWidth - marginX);
          resolve2DZoneOverlaps(
            freeRegularNodes,
            marginX,
            maxRowWidth - marginX,
            freeStartTopY - 10,
            28,
            22
          );
          snapDockedComplexes(nodeMap);
        }

        const maxRegY =
          regularNodes.length > 0
            ? Math.max(...regularNodes.map(n => n.y + n.h / 2))
            : maxMembraneDockedBottomY + 25;

        if (sinkNodes.length > 0) {
          const sinkRowY = regularNodes.length > 0 ? maxRegY + 56 : zone.topY + 50;
          sinkNodes.forEach(s => {
            s.y = sinkRowY;
            const inParents = state.edges
              .filter(e => e.target === s.id)
              .map(e => nodeMap.get(e.source))
              .filter(Boolean);
            if (inParents.length > 0) {
              s.x = Math.round(
                inParents.reduce((sum, p) => sum + p.x, 0) / inParents.length
              );
            }
          });
          sinkNodes.sort((a, b) => a.x - b.x);
          resolveRowCollisions(sinkNodes, marginX, maxRowWidth - marginX, 42, state.nodes);
          zone.bottomY = sinkRowY + 42;
        } else {
          zone.bottomY = maxRegY + 34;
        }

        zNodes.forEach(n => {
          maxRowWidth = Math.max(maxRowWidth, n.x + n.w / 2 + marginX);
        });
        yCursor = zone.bottomY + 48;
      }
    });

    let finalMaxX = maxRowWidth;
    let finalMaxY = yCursor;

    savedPins.forEach((pos, id) => {
      const nd = nodeMap.get(id);
      if (nd) {
        nd.x = pos.x;
        nd.y = pos.y;
        finalMaxX = Math.max(finalMaxX, nd.x + nd.w / 2 + 85);
        finalMaxY = Math.max(finalMaxY, nd.y + nd.h / 2 + 45);
      }
    });

    state.canvasWidth = Math.max(1200, Math.ceil(finalMaxX / 50) * 50);
    state.canvasHeight = Math.max(600, finalMaxY + 30);

    state.nodes.forEach(n => {
      n.x = Math.round(n.x);
      n.y = Math.round(n.y);
      n.editorPosition = { x: n.x, y: n.y };
    });
  }

  // ============================================================================
  // 5. THREE-PASS GEMINI ENGINE WITH SESSION QUOTA MEMORY & MULTI-KEY ROTATION
  // ============================================================================
  function optimizeImageDataUrl(dataUrl, maxDim = 1600) {
    return new Promise((resolve, reject) => {
      if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
        reject(new Error("Invalid or corrupted image data URL."));
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (!img.width || !img.height) {
          reject(new Error("Decoded image has invalid zero dimensions."));
          return;
        }
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Browser failed to initialize 2D canvas context."));
          return;
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () =>
        reject(new Error("Failed to decode image file. The image may be corrupted."));
      img.src = dataUrl;
    });
  }

  function parseModelJson(rawText) {
    const cleaned = String(rawText || "")
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    if (!cleaned) {
      throw new Error("Model returned an empty JSON string.");
    }
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
          return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
        } catch (innerErr) {
          throw new Error(`Malformed JSON from model: ${innerErr.message}`);
        }
      }
      throw new Error(`Malformed JSON from model: ${e.message}`);
    }
  }

  function isDailyQuotaErrorMessage(httpStatus, msg) {
    if (httpStatus !== 429) return false;
    const low = String(msg || "").toLowerCase();
    return (
      low.includes("per day") ||
      low.includes("per_day") ||
      low.includes("daily") ||
      low.includes("free_tier_requests") ||
      low.includes("please retry in ")
    );
  }

  async function callGemini(contents, statusPrefix, statusCallback, timeoutMs = 45000) {
    const apiKeys = getApiKeysList();
    if (apiKeys.length === 0) {
      throw new Error("Missing Gemini API key. Paste your key in the top-right input first.");
    }

    const preferredModel = getModelName();
    const candidateModels = Array.from(new Set([preferredModel, ...FALLBACK_MODELS]));

    const fullFlashModels = candidateModels.filter(m => !m.endsWith("-lite"));
    const liteModels = candidateModels.filter(m => m.endsWith("-lite"));

    const executionPlan = [];
    if (preferredModel.endsWith("-lite")) {
      apiKeys.forEach((key, keyIdx) => {
        candidateModels.forEach(model => executionPlan.push({ key, keyIdx, model }));
      });
    } else {
      fullFlashModels.forEach(model => {
        apiKeys.forEach((key, keyIdx) => executionPlan.push({ key, keyIdx, model }));
      });
      liteModels.forEach(model => {
        apiKeys.forEach((key, keyIdx) => executionPlan.push({ key, keyIdx, model }));
      });
    }

    const startTime = Date.now();
    const ticker = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (statusCallback) statusCallback(`${statusPrefix} (${elapsed}s)...`);
    }, 1000);

    let lastErr = null;
    const hostPart = ["https://generativelanguage", "googleapis", "com"].join(".");
    const apiBase = [hostPart, "v1beta", "models"].join("/");

    try {
      for (let pIdx = 0; pIdx < executionPlan.length; pIdx++) {
        const { key, keyIdx, model: modelName } = executionPlan[pIdx];
        const sessionCacheKey = `key_${keyIdx}::${modelName}`;

        if (exhaustedDailyKeyModels.has(sessionCacheKey)) {
          continue;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          if (statusCallback) statusCallback(`${statusPrefix} (0s)...`);
          const endpoint = `${apiBase}/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(key)}`;
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              contents,
              generationConfig: {
                responseMimeType: "application/json"
              }
            })
          });
          clearTimeout(timer);

          let data = null;
          try {
            data = await response.json();
          } catch (jsonErr) {
            throw new Error(`Invalid HTTP response body (HTTP ${response.status}).`);
          }

          if (!response.ok || data?.error) {
            const msg = data?.error?.message || `HTTP ${response.status}`;

            if (isDailyQuotaErrorMessage(response.status, msg)) {
              exhaustedDailyKeyModels.add(sessionCacheKey);
            }

            if (
              (response.status === 404 ||
                response.status === 403 ||
                response.status === 429 ||
                response.status === 503) &&
              pIdx < executionPlan.length - 1
            ) {
              continue;
            }
            throw new Error(`Gemini API Error (${response.status} on ${modelName}): ${msg}`);
          }

          const candidate = data?.candidates?.[0];
          if (!candidate) {
            throw new Error("Gemini returned no candidates in response.");
          }
          const parts = candidate.content?.parts || [];
          const textPart =
            parts.find(p => typeof p.text === "string" && !p.thought) || parts[parts.length - 1];
          if (!textPart?.text) {
            throw new Error("Empty text content returned from model.");
          }
          return parseModelJson(textPart.text);
        } catch (err) {
          clearTimeout(timer);
          lastErr =
            err.name === "AbortError"
              ? new Error(`Gemini API request timed out after ${Math.round(timeoutMs / 1000)}s.`)
              : err;
          if (pIdx === executionPlan.length - 1) {
            throw lastErr;
          }
        }
      }
      throw lastErr || new Error("All Gemini quota buckets failed.");
    } finally {
      clearInterval(ticker);
    }
  }

  async function digitizeUploadedFigure() {
    const keys = getApiKeysList();
    if (keys.length === 0) {
      alert("Please paste your Gemini API key in the top-right box first.");
      return;
    }
    if (!uploadedImageBase64) {
      alert("Please choose a pathway image first using 'Upload Figure'.");
      return;
    }
    const btn = document.getElementById("extractBtn");
    if (btn) btn.disabled = true;

    try {
      if (btn) btn.textContent = "Preparing Image...";
      const optimizedDataUrl = await optimizeImageDataUrl(uploadedImageBase64, 1600);
      const mimeType = optimizedDataUrl.split(";")[0].split(":")[1];
      const base64Data = optimizedDataUrl.split(",")[1];

      // =========================================================================
      // PASS 1: CONTOUR-BASED COMPARTMENT, SUBUNIT & ARROW EXTRACTION
      // =========================================================================
      const pass1Prompt = `You are a precision scientific figure digitizer.
Digitize the pathway diagram in this image by following these 3 visual steps:

STEP 1 — IDENTIFY COMPARTMENT REGIONS ('zones'):
Look at the background boundaries drawn in the figure (membranes, organelle outlines, or region dividers) and list each distinct compartment in 'zones', ordered from the outermost/top region (order: 0) to the innermost/bottom region:
- Give each zone a descriptive 'id' and 'label' matching the figure's biology. Only include an extracellular zone if labeled extracellular ligands are present.
- Assign each zone one of these 4 geometric 'visualStyle' values based on how it is drawn:
  * "membrane_bilayer": A boundary line or lipid bilayer that transmembrane proteins span across.
  * "enclosed_organelle": A closed loop/oval boundary enclosing an interior space (e.g., Nucleus, Mitochondrion).
  * "open_region": An open space outside, between, or around boundaries (e.g., Cytosol).
  * "outcome_banner": A terminal summary or phenotype banner.

STEP 2 — EXTRACT EVERY LABELED SHAPE & SUBUNIT BY VISUAL CONTAINMENT ('nodes'):
For each labeled shape drawn in the figure, assign its 'zoneId' strictly by its physical position relative to the drawn boundary lines:
- Spans across a "membrane_bilayer" line (even if that membrane curves diagonally across the page)? -> Assign to that membrane zone with "shape": "transmembrane".
- Physically inside the closed contour of an "enclosed_organelle"? -> Assign to that enclosed organelle zone.
- Inside the cell membrane, but OUTSIDE the closed contour of an organelle (even if drawn near the bottom-left or bottom-right corner next to the organelle)? -> Assign to the intracellular "open_region" (cytosol) zone!
- DOCKED SUBUNITS ('dockedTo') vs. MULTI-SUBUNIT COMPLEXES ('subunits'):
  * If an intracellular subunit oval is physically touching/docked to a receptor tail OR touching a cytosolic kinase/scaffold (such as a STAT monomer touching a cytosolic Src/Abl box) with NO arrow drawn between them, assign its 'zoneId' to the intracellular "open_region" (cytosol) zone, set "dockedTo": "<parent_node_id>", and do NOT create an arrow between them!
  * If a free-standing cytosolic or nuclear complex is drawn as a cluster of touching subunit pills/ovals that act together as a unit (for example, a homodimer like ["STAT3", "STAT3"] or a multi-protein complex like ["CARMA1", "BCL10", "MALT1"], ["NEMO", "IKKa", "IKKb"], ["IkBa", "p65", "p50"], ["TAB2/3", "TAK1"], ["p100", "RelB"], ["p52", "RelB"], ["cRel", "p50"], ["p65", "p50"]), list its individual subunit names in the node's 'subunits' array and set "shape": "multi_subunit_cluster"!
  * NEVER set 'dockedTo' if there is a visible arrow (→) or T-bar (⊣) connecting the two shapes!
  * Ignore small unlabeled decorative circles floating outside the membrane unless they have a text label.
- MODIFICATION BADGES:
  * Small attached circles ("P", "ub", "GTP", "GDP", "Me", "Ac") go in the parent node's 'modifications' array. Never create a standalone node for "P" or "ub".
- CHROMATIN / DNA STRANDS:
  * If a DNA helix has a labeled box on or next to it (e.g., "Target Genes"), use ONLY that labeled box as the node (with "shape": "dna_target").

STEP 3 — TRACE EVERY DRAWN ARROW & T-BAR TO ITS EXACT SUBUNIT ('edges'):
Scan the image and trace EVERY visible line connecting one shape to another:
- Solid line with arrowhead (→): "type": "activates"
- Line with flat perpendicular T-bar (⊣): "type": "inhibits"
- Dashed/dotted line with arrowhead (⇢): "type": "translocates"
- Line with a "?" written beside it: "type": "uncertain", "label": "?"
- SUBUNIT PRECISION: When an arrow or T-bar (⊣) points to a specific subunit docked to a receptor (for example, an inhibitor like SOCS having separate T-bar lines pointing to a docked kinase like JAK and a docked transcription factor like STAT3 under a receptor), record each edge to that EXACT subunit's node ID—never collapse multiple T-bar lines into one or redirect them to the parent receptor!

Return ONLY valid JSON:
{
  "title": "Pathway Title",
  "zones": [
    { "id": "zone_membrane", "label": "Plasma Membrane", "order": 0, "visualStyle": "membrane_bilayer" },
    { "id": "zone_cytosol", "label": "Cytosol", "order": 1, "visualStyle": "open_region" },
    { "id": "zone_nucleus", "label": "Nucleus", "order": 2, "visualStyle": "enclosed_organelle" }
  ],
  "legend": [],
  "nodes": [
    {
      "id": "unique_snake_case_id",
      "label": "Exact Label",
      "subunits": [],
      "dockedTo": null,
      "modifications": ["P"],
      "zoneId": "zone_cytosol",
      "shape": "oval",
      "fillColor": "#e0f2fe",
      "borderColor": "#334155",
      "origX": 450,
      "origY": 320,
      "description": "1-sentence role."
    }
  ],
  "edges": [
    { "id": "e1", "source": "source_id", "target": "target_id", "type": "activates", "label": "" }
  ]
}`;

      const graphData = await callGemini(
        [
          {
            parts: [
              { text: pass1Prompt },
              { inlineData: { mimeType, data: base64Data } }
            ]
          }
        ],
        "Pass 1/3: Digitizing",
        statusText => {
          if (btn) btn.textContent = statusText;
        }
      );

      if (!graphData || !Array.isArray(graphData.nodes) || !graphData.nodes.length) {
        throw new Error("Pass 1 returned no valid pathway elements from the uploaded image.");
      }

      state = compileRawGraph({
        title: String(graphData.title || "Digitized Pathway").trim(),
        biologicalContext: "Verifying visual compartments, subunits & arrows against source image...",
        plausibilitySummary: "Running Pass 2 Visual & Subunit Arrow Verifier...",
        layoutMode: "source",
        isAligned: true,
        canvasWidth: 1200,
        canvasHeight: 660,
        legend: graphData.legend || [],
        zones: graphData.zones || [],
        nodes: graphData.nodes || [],
        edges: graphData.edges || [],
        issues: [],
        changelog: []
      });

      computeLayout({ preservePinned: false });

      appendChangelog(
        "Pass 1 Complete",
        `Extracted ${state.nodes.length} elements and ${state.edges.length} interactions.`
      );
      renderAll();

      // =========================================================================
      // PASS 2: SUBUNIT-LEVEL ARROW & COMPARTMENT AUDITOR
      // =========================================================================
      const readableChecklist = buildReadablePass2Checklist(state);

      const pass2Prompt = `You are a Visual Fidelity Auditor. Compare the extracted pathway checklist below against the uploaded image and fix ANY compartment errors, missing docked subunits, or missing/misdirected arrows.

EXTRACTED COMPARTMENT & ARROW CHECKLIST FROM PASS 1:
${readableChecklist}

AUDIT THIS CHECKLIST AGAINST THE IMAGE IN 2 STEPS:

1. COMPARTMENT & DOCKING CHECK:
   - Look at the enclosed organelle (nuclear) boundary contour drawn in the image:
     * A node belongs in the 'enclosed_organelle' (Nucleus) zone ONLY if the shape itself is physically drawn INSIDE that closed boundary line.
     * If a shape sits OUTSIDE the closed organelle boundary line and has a dashed translocation arrow (⇢) crossing INTO the boundary, that shape MUST stay in the 'open_region' (Cytosol) zone, and its dashed translocation arrow should point to the target inside the organelle!
   - If two shapes are physically touching in the cytosol or on a receptor tail with NO arrow drawn between them (such as a kinase box and a touching substrate oval), link them via 'convertEdgesToDocking' or set 'dockedTo' in 'upsertNodes' instead of leaving a fake arrow between them.

2. MISSING ARROW & T-BAR CHECK:
   - Check every node in the checklist that has "Incoming arrows: none" or "Outgoing arrows: none": look at that shape in the image and add any missing drawn arrows (→, ⇢, ⊣, ?) to 'upsertEdges' using EXACT node 'id' values from the checklist.
   - Check every inhibitor (e.g., SOCS, CYLD, A20, PTPs, PIAS3, KLF4, IkBa/e): if an inhibitor has multiple T-bar lines (⊣) pointing to different docked subunits of a receptor complex (such as one T-bar to a docked JAK and a second T-bar to a docked STAT3), ensure BOTH "type": "inhibits" edges exist in 'upsertEdges' pointing to those exact subunit node IDs!
   - Preserve any "?" label on uncertain edges.

Return ONLY valid JSON:
{
  "correctionSummary": "Concise summary of compartment, subunit docking, and arrow fixes.",
  "convertEdgesToDocking": [
    { "parent": "parent_node_id", "child": "touching_node_id" }
  ],
  "upsertNodes": [
    { "id": "exact_node_id", "label": "Exact Label", "zoneId": "target_zone_id", "shape": "oval", "dockedTo": null }
  ],
  "removeNodeIds": [],
  "upsertEdges": [
    { "source": "exact_source_id", "target": "exact_target_id", "type": "activates", "label": "" }
  ],
  "removeEdges": [
    { "source": "wrong_source_id", "target": "wrong_target_id" }
  ]
}`;

      const pass2Data = await callGemini(
        [
          {
            parts: [
              { text: pass2Prompt },
              { inlineData: { mimeType, data: base64Data } }
            ]
          }
        ],
        "Pass 2/3: Verifying Subunits & Arrows",
        statusText => {
          if (btn) btn.textContent = statusText;
        }
      );

      if (pass2Data && typeof pass2Data === "object") {
        const hasFixes =
          (Array.isArray(pass2Data.convertEdgesToDocking) && pass2Data.convertEdgesToDocking.length > 0) ||
          (Array.isArray(pass2Data.upsertNodes) && pass2Data.upsertNodes.length > 0) ||
          (Array.isArray(pass2Data.removeNodeIds) && pass2Data.removeNodeIds.length > 0) ||
          (Array.isArray(pass2Data.upsertEdges) && pass2Data.upsertEdges.length > 0) ||
          (Array.isArray(pass2Data.removeEdges) && pass2Data.removeEdges.length > 0);

        if (hasFixes) {
          applyPatch(pass2Data, "Pass 2 Visual Verifier", [], {
            skipUndo: true,
            skipRender: true,
            isAutomatedVerifier: true
          });
        }
      }

      initialDigitizedSnapshot = JSON.parse(JSON.stringify(state));
      renderAll();

      // =========================================================================
      // PASS 3: SENIOR SCIENTIFIC & MECHANISTIC AUDITOR (USER REVIEW WIZARD)
      // =========================================================================
      const verifiedChecklist = buildReadablePass2Checklist(state);

      const pass3Prompt = `You are a Senior Cell Signaling Biologist auditing a digitized pathway figure for a scientist.
Below is the verified compartment and interaction checklist extracted from the figure:
${verifiedChecklist}

Generate 3 to 5 high-value, scientifically rigorous Review Items for the scientist in the interactive Review Wizard.
STRICT PATCH QUALITY RULES:
1. Every issue MUST include a concrete, self-contained, immediately executable 'patch' object using EXACT node IDs from the checklist above (or inserting real, specific canonical protein names—NEVER use placeholder words like "(putative/canonical)", "Unknown", or "Intermediate" in a node label!).
2. Audit across these 5 scientific dimensions:
   - SUBCELLULAR LOCALIZATION & COMPARTMENT ACCURACY ("category": "biological_plausibility"): Are any proteins placed in a biologically inaccurate cellular compartment? Fix via 'patch.upsertNodes' with the correct 'zoneId'.
   - INCORRECT PATHWAY LINEUPS & BIOLOGICAL PLAUSIBILITY ("category": "biological_plausibility"): Are any receptors, adaptors, kinases, or transcription factors wired in a non-canonical or biologically suspect cascade?
   - UNVERIFIED OR PUTATIVE TRANSITIONS ("category": "biological_plausibility"): If the figure contains a speculative '?' arrow, flag it and set 'patch.removeEdges' to remove the speculative '?' edge if the scientist clicks 'Apply Fix' (versus 'Keep As Is').
   - MISSING CANONICAL INTERMEDIATES ("category": "biological_plausibility"): Where the author skipped essential transducers, provide the specific canonical proteins in 'patch.upsertNodes' and wire them sequentially in 'patch.upsertEdges' while removing the shortcut edge in 'patch.removeEdges'.
   - STATE TRANSITION CONDENSATION & NOMENCLATURE TYPOS ("category": "state_transition_choice" or "nomenclature_or_visual"): Offer to condense duplicated unmodified->modified state nodes ("condenseStates": true, "mergeIntoId": "<active_id>", "removeNodeIds": ["<precursor_id>"]) or fix author spelling typos in labels (such as "Scr/Abl" -> "Src/Abl") via 'patch.upsertNodes'.

Return ONLY valid JSON matching these EXACT key names:
{
  "biologicalContext": "Specific Cell Type / Signaling System",
  "plausibilitySummary": "2-sentence rigorous assessment of the biological accuracy, canonical lineup, and any speculative/putative links in this figure.",
  "issues": [
    {
      "category": "biological_plausibility",
      "title": "Concise scientific issue title",
      "targetNodeIds": ["exact_node_id_1", "exact_node_id_2"],
      "problemDescription": "Clear explanation of the biological question, localization error, unverified '?' transition, pathway lineup concern, missing intermediate, or nomenclature error.",
      "proposedFixRationale": "Exact description of the concrete change that will be applied if the user clicks 'Apply Fix'.",
      "patch": {
        "upsertNodes": [
          { "id": "exact_or_new_id", "label": "Canonical Name", "zoneId": "zone_id", "shape": "oval", "modifications": [] }
        ],
        "removeNodeIds": ["node_id_to_remove"],
        "mergeIntoId": "",
        "condenseStates": false,
        "upsertEdges": [
          { "source": "exact_source_id", "target": "exact_target_id", "type": "activates", "label": "" }
        ],
        "removeEdges": [
          { "source": "exact_source_id", "target": "exact_target_id" }
        ]
      }
    }
  ]
}`;

      const auditData = await callGemini(
        [
          {
            parts: [
              { text: pass3Prompt },
              { inlineData: { mimeType, data: base64Data } }
            ]
          }
        ],
        "Pass 3/3: Scientific Audit",
        statusText => {
          if (btn) btn.textContent = statusText;
        }
      );

      state.biologicalContext = String(auditData?.biologicalContext || "Cellular Signaling").trim();
      state.plausibilitySummary = String(
        auditData?.plausibilitySummary || "Pathway audited for biological plausibility."
      ).trim();

      state.issues = validateAndSanitizeIssues(auditData?.issues, state);

      appendChangelog(
        "Pass 3 Scientific Audit",
        `Generated ${state.issues.length} verified scientific review cards for '${state.biologicalContext}'.`
      );
      initialDigitizedSnapshot = JSON.parse(JSON.stringify(state));
      undoStack = [];
      redoStack = [];
      updateUndoRedoButtons();
      document.getElementById("restoreBtn")?.classList.remove("hidden");
      document.getElementById("exportLogBtn")?.classList.remove("hidden");
      currentIssueIndex = 0;
      showCompletedReviewBanner = false;
      renderAll();
    } catch (err) {
      alert(err.message || "Failed to digitize pathway figure.");
    } finally {
      if (btn) {
        btn.textContent = "Digitize Figure";
        btn.disabled = false;
      }
    }
  }

  async function handleNaturalLanguagePrompt() {
    if (!state) return;
    const input = document.getElementById("nlPromptInput");
    const promptText = input?.value.trim() || "";
    if (!promptText) return;

    const lower = promptText.toLowerCase();
    if (
      lower.includes("phosphorylation") &&
      (lower.includes("capital p") || lower.includes("'p'") || lower.includes("to p"))
    ) {
      applyPatch({ normalizeAllModifications: true }, `Prompt ("${promptText}")`);
      if (input) input.value = "";
      return;
    }

    const keys = getApiKeysList();
    if (keys.length === 0) {
      alert("Please paste your Gemini API key in the top bar.");
      return;
    }

    const btn = document.getElementById("nlSubmitBtn");
    if (btn) btn.disabled = true;

    try {
      const sysPrompt = `You are a biological pathway graph editor.
Zones: ${JSON.stringify(state.zones)}
Nodes: ${JSON.stringify(
        state.nodes.map(n => ({
          id: n.id,
          label: n.label,
          subunits: n.subunits,
          dockedTo: n.dockedTo,
          modifications: n.modifications,
          zoneId: n.zoneId,
          shape: n.shape,
          origX: n.sourcePosition.x,
          origY: n.sourcePosition.y
        }))
      )}
Edges: ${JSON.stringify(state.edges)}
Translate the user's request into a complete executable JSON patch object:
{
  "upsertNodes": [ { "id": "EXISTING_OR_NEW_ID", "label": "Label", "subunits": [], "dockedTo": null, "modifications": ["P"], "shape": "oval", "zoneId": "zone_id", "origX": 500, "origY": 300 } ],
  "removeNodeIds": [],
  "mergeIntoId": "",
  "upsertEdges": [ { "source": "ID_OR_LABEL", "target": "ID_OR_LABEL", "type": "activates", "label": "" } ],
  "removeEdges": [ { "source": "ID_OR_LABEL", "target": "ID_OR_LABEL" } ],
  "normalizeAllModifications": false
}
CRITICAL RULES:
1. Encode ALL parts of the user's request using real biological names (never placeholder words).
2. DO NOT include existing nodes in 'upsertNodes' unless the user specifically asked to rename, modify, or move those existing nodes.
User request: "${promptText}"`;

      const parsed = await callGemini(
        [{ parts: [{ text: sysPrompt }] }],
        "Updating",
        statusText => {
          if (btn) btn.textContent = statusText;
        }
      );
      applyPatch(parsed, `Prompt ("${promptText}")`);
      if (input) input.value = "";
    } catch (err) {
      alert(err.message || "Failed to apply prompt update.");
    } finally {
      if (btn) {
        btn.textContent = "Update Diagram";
        btn.disabled = false;
      }
    }
  }

  // ============================================================================
  // 6. SVG RENDERER WITH COMPLEX-AWARE OUTER PERIMETER ANCHORING
  // ============================================================================
  function getPerimeterIntersection(cx, cy, w, h, targetX, targetY) {
    const dx = targetX - cx;
    const dy = targetY - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const hw = w / 2 + 7;
    const hh = h / 2 + 7;
    const scale = Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh, 0.001);
    return { x: cx + dx / scale, y: cy + dy / scale };
  }

  function getComplexMembers(node, allNodes) {
    const nodeMap = new Map(allNodes.map(n => [n.id, n]));
    const root = getRootDockAnchor(node, nodeMap);
    return allNodes.filter(n => {
      if (n.id === root.id) return true;
      const r = getRootDockAnchor(n, nodeMap);
      return r && r.id === root.id && !isExtracellularDockedNode(n, root, state?.zones);
    });
  }

  function getComplexAwareEndpoints(s, t, allNodes) {
    const sMembers = getComplexMembers(s, allNodes);
    const tMembers = getComplexMembers(t, allNodes);

    let effSX = s.x;
    let effSY = s.y;
    let effSW = s.w;
    let effSH = s.h;

    if (sMembers.length > 1 && !s.dockedTo && t.y > s.y + 30) {
      const minX = Math.min(...sMembers.map(m => m.x - m.w / 2));
      const maxX = Math.max(...sMembers.map(m => m.x + m.w / 2));
      const maxY = Math.max(...sMembers.map(m => m.y + m.h / 2));
      const dockedOnly = sMembers.filter(m => m.id !== s.id);
      const minDockedY = Math.min(...dockedOnly.map(m => m.y - m.h / 2));
      effSX = Math.round((minX + maxX) / 2);
      effSY = Math.round((minDockedY + maxY) / 2);
      effSW = maxX - minX;
      effSH = maxY - minDockedY;
    }

    let p1 = getPerimeterIntersection(effSX, effSY, effSW, effSH, t.x, t.y);
    let p2 = getPerimeterIntersection(t.x, t.y, t.w, t.h, effSX, effSY);

    if (tMembers.length > 1) {
      const siblings = tMembers.filter(m => m.id !== t.id);
      const isBlockedBySibling = siblings.some(sib => {
        if (Math.abs(sib.y - t.y) > (sib.h + t.h) / 2) return false;
        const sibBetweenRight = s.x > t.x && sib.x > t.x && sib.x < s.x;
        const sibBetweenLeft = s.x < t.x && sib.x < t.x && sib.x > s.x;
        return sibBetweenRight || sibBetweenLeft;
      });

      if (isBlockedBySibling) {
        const approachFromBelow = s.y >= t.y;
        p2 = {
          x: t.x + (s.x >= t.x ? 8 : -8),
          y: approachFromBelow ? t.y + t.h / 2 + 7 : t.y - t.h / 2 - 7
        };
      }
    }

    return { p1, p2 };
  }

  // Unified obstacle-driven router: uses direct curves when the line of sight is clear,
  // and bows cleanly around blocking intermediate nodes when obstacles lie in the path.
  function computeObstacleFreePath(s, t, p1, p2, allNodes) {
    const sMembers = getComplexMembers(s, allNodes);
    const tMembers = getComplexMembers(t, allNodes);
    const excludeIds = new Set([...sMembers.map(m => m.id), ...tMembers.map(m => m.id)]);

    const siblings = tMembers.filter(m => m.id !== t.id);
    const blockedSibling = siblings.find(sib => {
      if (Math.abs(sib.y - t.y) > (sib.h + t.h) / 2) return false;
      return (s.x > t.x && sib.x > t.x && sib.x < s.x) || (s.x < t.x && sib.x < t.x && sib.x > s.x);
    });

    if (blockedSibling) {
      const ctrlX = blockedSibling.x;
      const ctrlY = s.y >= t.y ? blockedSibling.y + blockedSibling.h / 2 + 26 : blockedSibling.y - blockedSibling.h / 2 - 26;
      return {
        d: `M ${p1.x} ${p1.y} Q ${ctrlX} ${ctrlY} ${p2.x} ${p2.y}`,
        labelX: Math.round(0.25 * p1.x + 0.5 * ctrlX + 0.25 * p2.x),
        labelY: Math.round(0.25 * p1.y + 0.5 * ctrlY + 0.25 * p2.y)
      };
    }

    const minY = Math.min(p1.y, p2.y) - 12;
    const maxY = Math.max(p1.y, p2.y) + 12;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const lenSq = dx * dx + dy * dy || 1;
    const hitObstacles = allNodes.filter(other => {
      if (excludeIds.has(other.id)) return false;
      if (other.y < minY || other.y > maxY) return false;
      const u = Math.max(0, Math.min(1, ((other.x - p1.x) * dx + (other.y - p1.y) * dy) / lenSq));
      const projX = p1.x + u * dx;
      const projY = p1.y + u * dy;
      return (
        Math.abs(other.x - projX) < other.w / 2 + 16 &&
        Math.abs(other.y - projY) < other.h / 2 + 14
      );
    });

    if (hitObstacles.length > 0) {
      const minObsLeft = Math.min(...hitObstacles.map(o => o.x - o.w / 2));
      const maxObsRight = Math.max(...hitObstacles.map(o => o.x + o.w / 2));
      const midX = (p1.x + p2.x) / 2;
      const detourRight = midX >= (minObsLeft + maxObsRight) / 2;
      const ctrlX = detourRight ? maxObsRight + 48 : minObsLeft - 48;
      const ctrlY = Math.round((p1.y + p2.y) / 2);
      return {
        d: `M ${p1.x} ${p1.y} Q ${ctrlX} ${ctrlY} ${p2.x} ${p2.y}`,
        labelX: Math.round(0.25 * p1.x + 0.5 * ctrlX + 0.25 * p2.x),
        labelY: Math.round(0.25 * p1.y + 0.5 * ctrlY + 0.25 * p2.y)
      };
    }

    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const curveOffset = Math.abs(p1.x - p2.x) > 280 ? -16 : 0;
    return {
      d: `M ${p1.x} ${p1.y} Q ${mx} ${my + curveOffset} ${p2.x} ${p2.y}`,
      labelX: Math.round(mx),
      labelY: Math.round(my + curveOffset * 0.5)
    };
  }

  function isDarkColor(hex) {
    const c = (hex || "#ffffff").replace("#", "");
    if (c.length !== 6) return false;
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.52;
  }

  function renderEdgePathsOnly() {
    if (!state) return;
    const edgeLayer = document.getElementById("edgeLayer");
    if (!edgeLayer) return;
    edgeLayer.innerHTML = "";
    const nodeMap = Object.fromEntries(state.nodes.map(n => [n.id, n]));

    state.edges.forEach((edge, idx) => {
      const s = nodeMap[edge.source];
      const t = nodeMap[edge.target];
      if (!s || !t) return;
      const { p1, p2 } = getComplexAwareEndpoints(s, t, state.nodes);
      const route = computeObstacleFreePath(s, t, p1, p2, state.nodes);
      const eType = VALID_EDGE_TYPES.has(edge.type) ? edge.type : "activates";
      const strokeColor =
        eType === "inhibits"
          ? "#e11d48"
          : eType === "translocates"
          ? "#4f46e5"
          : eType === "uncertain"
          ? "#d97706"
          : "#334155";

      const gEdge = document.createElementNS("http://www.w3.org/2000/svg", "g");
      gEdge.style.cursor = "pointer";
      gEdge.setAttribute(
        "title",
        "Click to cycle polarity (Activates → Inhibits → Translocates → Uncertain '?') • Shift+Click to delete arrow"
      );
      gEdge.addEventListener("click", evt => {
        evt.stopPropagation();
        if (evt.shiftKey) {
          applyPatch(
            { removeEdges: [{ source: edge.source, target: edge.target }] },
            "Deleted Arrow"
          );
        } else {
          cycleEdgePolarity(idx);
        }
      });

      const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hitPath.setAttribute("d", route.d);
      hitPath.setAttribute("fill", "none");
      hitPath.setAttribute("stroke", "transparent");
      hitPath.setAttribute("stroke-width", "16");
      hitPath.style.pointerEvents = "stroke";
      gEdge.appendChild(hitPath);

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", route.d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", strokeColor);
      path.setAttribute("stroke-width", "2.4");
      if (eType === "translocates" || eType === "uncertain") {
        path.setAttribute("stroke-dasharray", "6,5");
      }
      path.setAttribute(
        "marker-end",
        `url(#arrow-${eType === "uncertain" ? "uncertain" : eType})`
      );
      path.classList.add("edge-path");
      gEdge.appendChild(path);

      const badgeTextStr = String(edge.label || (eType === "uncertain" ? "?" : "")).trim();
      if (badgeTextStr) {
        const bw = Math.max(20, badgeTextStr.length * 7 + 10);
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", route.labelX - bw / 2);
        rect.setAttribute("y", route.labelY - 10);
        rect.setAttribute("width", bw);
        rect.setAttribute("height", "20");
        rect.setAttribute("rx", "10");
        rect.setAttribute("fill", badgeTextStr === "?" ? "#fef08a" : "#f1f5f9");
        rect.setAttribute("stroke", badgeTextStr === "?" ? "#d97706" : "#475569");
        rect.setAttribute("stroke-width", "1.5");

        const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
        txt.setAttribute("x", route.labelX);
        txt.setAttribute("y", route.labelY + 4);
        txt.setAttribute("font-size", "11");
        txt.setAttribute("font-weight", "800");
        txt.setAttribute("text-anchor", "middle");
        txt.setAttribute("fill", "#0f172a");
        txt.textContent = badgeTextStr;

        gEdge.appendChild(rect);
        gEdge.appendChild(txt);
      }

      edgeLayer.appendChild(gEdge);
    });
  }

  function renderCanvas() {
    const svg = document.getElementById("bioCanvas");
    const compLayer = document.getElementById("compartmentLayer");
    const edgeLayer = document.getElementById("edgeLayer");
    const nodeLayer = document.getElementById("nodeLayer");
    if (!svg || !compLayer || !edgeLayer || !nodeLayer) return;

    compLayer.innerHTML = "";
    edgeLayer.innerHTML = "";
    nodeLayer.innerHTML = "";

    if (!state) {
      compLayer.innerHTML = `
        <text x="600" y="340" font-size="14" font-weight="600" text-anchor="middle" fill="#94a3b8">
          Upload a pathway image and click "Digitize Figure" to begin.
        </text>
      `;
      return;
    }

    const W = state.canvasWidth || 1200;
    const H = state.canvasHeight || 660;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    state.nodes.forEach(n => {
      const dims = computeNodeDimensions(n);
      n.w = dims.width;
      n.h = dims.height;
    });

    const sortedZones = [...state.zones].sort((a, b) => a.order - b.order);
    const firstMembraneOrder =
      sortedZones.find(z => z.visualStyle === "membrane_bilayer")?.order ?? 999;
    let zonesSVG = "";

    sortedZones.forEach((z, idx) => {
      const zNodes = state.nodes.filter(n => n.zoneId === z.id);
      const isOuterOpenZone =
        z.visualStyle === "open_region" && z.order < firstMembraneOrder;
      const undockedOuter = isOuterOpenZone ? zNodes.filter(n => !n.dockedTo) : zNodes;
      if (isOuterOpenZone && undockedOuter.length === 0) {
        return;
      }

      const minY = z.topY ?? (idx === 0 ? 25 : idx === 1 ? 160 : 480);
      const maxY =
        z.bottomY ?? (zNodes.length ? Math.max(...zNodes.map(n => n.y)) + 55 : minY + 110);
      const bandH = Math.max(85, maxY - minY);
      const safeZoneLabel = escapeHtml(z.label.toUpperCase());

      if (z.visualStyle === "membrane_bilayer") {
        const tmNodes = zNodes.filter(n => n.shape === "transmembrane");
        const refNodes = tmNodes.length > 0 ? tmNodes : zNodes;
        const bilayerY =
          z.bilayerY ??
          (refNodes.length
            ? Math.round(refNodes.reduce((s, n) => s + n.y, 0) / refNodes.length)
            : minY + 75);
        let beads = "";
        for (let lx = 35; lx <= W - 35; lx += 18) {
          beads += `
            <circle cx="${lx}" cy="${bilayerY - 11}" r="4" fill="#38bdf8" stroke="#0284c7" stroke-width="1"/>
            <circle cx="${lx}" cy="${bilayerY + 11}" r="4" fill="#38bdf8" stroke="#0284c7" stroke-width="1"/>
          `;
        }
        zonesSVG += `
          <rect x="25" y="${bilayerY - 14}" width="${W - 50}" height="28" rx="6" fill="#e0f2fe" opacity="0.85"/>
          ${beads}
          <text x="40" y="${Math.max(20, bilayerY - 24)}" font-size="11" font-weight="800" fill="#0369a1" letter-spacing="0.05em">${safeZoneLabel}</text>
        `;
      } else if (z.visualStyle === "enclosed_organelle") {
        zonesSVG += `
          <rect x="65" y="${minY}" width="${W - 130}" height="${bandH}" rx="75" fill="#f8fafc" stroke="#94a3b8" stroke-width="6" stroke-dasharray="24,9"/>
          <text x="120" y="${minY + 26}" font-size="11" font-weight="800" fill="#475569" letter-spacing="0.05em">${safeZoneLabel}</text>
        `;
      } else if (z.visualStyle === "outcome_banner") {
        zonesSVG += `
          <rect x="40" y="${minY}" width="${W - 80}" height="${bandH}" rx="14" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="2"/>
          <text x="60" y="${minY + 24}" font-size="11" font-weight="800" fill="#334155" letter-spacing="0.05em">${safeZoneLabel}</text>
        `;
      } else {
        zonesSVG += `
          <text x="40" y="${minY + 22}" font-size="11" font-weight="800" fill="#64748b" letter-spacing="0.05em">${safeZoneLabel}</text>
        `;
      }
    });
    compLayer.innerHTML = zonesSVG;

    renderEdgePathsOnly();

    const activeIssue = state.issues[currentIssueIndex];
    const highlightSet = new Set();
    if (activeIssue && !showCompletedReviewBanner) {
      (activeIssue.targetNodeIds || []).forEach(id => {
        const resolved = resolveNode(id);
        if (resolved) highlightSet.add(resolved.id);
      });
    }

    state.nodes.forEach(node => {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("transform", `translate(${node.x}, ${node.y})`);
      g.setAttribute("filter", "url(#bioShadow)");
      g.classList.add("bio-node");

      const hw = node.w / 2;
      const hh = node.h / 2;
      const fill = /^#[0-9A-Fa-f]{6}$/.test(node.fillColor || "") ? node.fillColor : "#ffffff";
      const stroke = /^#[0-9A-Fa-f]{6}$/.test(node.borderColor || "") ? node.borderColor : "#334155";
      const textColor = isDarkColor(fill) ? "#ffffff" : "#0f172a";
      const safeLabel = escapeHtml(node.label);
      const cleanSubs = normalizeSubunits(node.label, node.subunits);

      const highlightRing = highlightSet.has(node.id)
        ? `<rect x="${-hw - 8}" y="${-hh - 8}" width="${node.w + 16}" height="${node.h + 16}" rx="14" fill="none" stroke="#4f46e5" class="pulse-highlight"/>`
        : "";

      let bodySVG = "";
      if (node.shape === "transmembrane") {
        bodySVG = `
          <rect x="-20" y="-36" width="11" height="58" rx="5.5" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
          <rect x="9" y="-36" width="11" height="58" rx="5.5" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
          <rect x="${-hw}" y="-4" width="${node.w}" height="28" rx="8" fill="#ffffff" stroke="${stroke}" stroke-width="2"/>
          <text x="0" y="14" font-size="11" font-weight="800" text-anchor="middle" fill="#0f172a">${safeLabel}</text>
        `;
      } else if (node.shape === "starburst") {
        const pts = [];
        const spikes = 14;
        for (let i = 0; i < spikes * 2; i++) {
          const rX = i % 2 === 0 ? hw : hw * 0.78;
          const rY = i % 2 === 0 ? hh + 4 : hh * 0.72;
          const a = (i * Math.PI) / spikes;
          pts.push(`${(Math.cos(a) * rX).toFixed(1)},${(Math.sin(a) * rY).toFixed(1)}`);
        }
        bodySVG = `
          <polygon points="${pts.join(" ")}" fill="${fill}" stroke="${stroke}" stroke-width="1.8"/>
          <text x="0" y="4" font-size="11" font-weight="800" text-anchor="middle" fill="${textColor}">${safeLabel}</text>
        `;
      } else if (node.shape === "proteasome") {
        bodySVG = `
          <ellipse cx="0" cy="-18" rx="38" ry="7" fill="#bae6fd" stroke="#0284c7" stroke-width="1.5"/>
          <rect x="-38" y="-14" width="76" height="28" rx="6" fill="#fda4af" stroke="#e11d48" stroke-width="1.8"/>
          <line x1="-38" y1="-4" x2="38" y2="-4" stroke="#e11d48" stroke-width="1.2"/>
          <line x1="-38" y1="5" x2="38" y2="5" stroke="#e11d48" stroke-width="1.2"/>
          <ellipse cx="0" cy="16" rx="38" ry="7" fill="#bae6fd" stroke="#0284c7" stroke-width="1.5"/>
          <text x="0" y="32" font-size="10.5" font-weight="800" text-anchor="middle" fill="#0f172a">${safeLabel}</text>
        `;
      } else if (node.shape === "dna_target") {
        bodySVG = `
          <path d="M ${-hw} 18 C ${-hw / 2} 4, 0 32, ${hw / 2} 18 C ${hw * 0.75} 8, ${hw} 26, ${hw} 18" fill="none" stroke="#15803d" stroke-width="2.6"/>
          <path d="M ${-hw} 18 C ${-hw / 2} 32, 0 4, ${hw / 2} 18 C ${hw * 0.75} 28, ${hw} 10, ${hw} 18" fill="none" stroke="#0f766e" stroke-width="2.6"/>
          <rect x="${-hw}" y="-20" width="${node.w}" height="30" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
          <text x="0" y="-1" font-size="11" font-weight="800" text-anchor="middle" fill="${textColor}">${safeLabel}</text>
        `;
      } else if (node.shape === "banner") {
        bodySVG = `
          <rect x="${-hw}" y="${-hh}" width="${node.w}" height="${node.h}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
          <text x="0" y="4" font-size="11.5" font-weight="800" text-anchor="middle" fill="${textColor}">${safeLabel}</text>
        `;
      } else if (cleanSubs.length >= 2) {
        const pad = 4;
        const innerW = node.w - pad * 2;
        const subW = Math.floor((innerW - (cleanSubs.length - 1) * 2) / cleanSubs.length);
        let pillsSVG = `<rect x="${-hw}" y="${-hh}" width="${node.w}" height="${node.h}" rx="14" fill="#f8fafc" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="3,2"/>`;
        let startX = -hw + pad;
        cleanSubs.forEach(subLbl => {
          const cx = Math.round(startX + subW / 2);
          pillsSVG += `
            <rect x="${startX}" y="${-hh + 4}" width="${subW}" height="${node.h - 8}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.8"/>
            <text x="${cx}" y="4" font-size="10.2" font-weight="800" text-anchor="middle" fill="${textColor}">${escapeHtml(subLbl)}</text>
          `;
          startX += subW + 2;
        });
        bodySVG = pillsSVG;
      } else if (node.shape === "oval") {
        bodySVG = `
          <ellipse cx="0" cy="0" rx="${hw}" ry="${hh}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
          <text x="0" y="4" font-size="11" font-weight="800" text-anchor="middle" fill="${textColor}">${safeLabel}</text>
        `;
      } else {
        bodySVG = `
          <rect x="${-hw}" y="${-hh}" width="${node.w}" height="${node.h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
          <text x="0" y="4" font-size="11" font-weight="800" text-anchor="middle" fill="${textColor}">${safeLabel}</text>
        `;
      }

      let badgesSVG = "";
      (node.modifications || []).forEach((rawMod, i) => {
        const mod = normalizeModBadge(rawMod);
        if (!mod) return;
        const bx = hw - 8 - i * 22;
        const by = -hh + 1;
        const bFill = mod === "P" ? "#fde047" : "#bbf7d0";
        const bRadius = mod.length > 2 ? 11 : 9.5;
        badgesSVG += `
          <circle cx="${bx}" cy="${by}" r="${bRadius}" fill="${bFill}" stroke="#334155" stroke-width="1.4"/>
          <text x="${bx}" y="${by + 3.5}" font-size="9.5" font-weight="800" text-anchor="middle" fill="#0f172a">${escapeHtml(mod)}</text>
        `;
      });

      g.innerHTML = highlightRing + bodySVG + badgesSVG;
      g.addEventListener("mousedown", e => startNodeDrag(e, node, g));
      g.addEventListener("dblclick", e => {
        e.stopPropagation();
        openNodeModal(node.id);
      });
      g.addEventListener("mouseenter", e => showHoverTooltip(e, node));
      g.addEventListener("mouseleave", hideHoverTooltip);
      g.addEventListener("click", e => {
        e.stopPropagation();
        inspectNode(node);
      });
      nodeLayer.appendChild(g);
    });

    const legendBar = document.getElementById("legendBar");
    if (legendBar) {
      if (state.legend && state.legend.length > 0) {
        legendBar.classList.remove("hidden");
        legendBar.innerHTML =
          `<span class="font-bold text-slate-600 uppercase text-[10px] tracking-wider">Figure Key:</span>` +
          state.legend
            .map(item => {
              const fill = /^#[0-9A-Fa-f]{6}$/.test(item.fillColor || "") ? item.fillColor : "#e0f2fe";
              const border = /^#[0-9A-Fa-f]{6}$/.test(item.borderColor || "")
                ? item.borderColor
                : "#475569";
              return `
                <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border" style="background:${fill}; border-color:${border}; color:${isDarkColor(fill) ? "#fff" : "#0f172a"}">
                  ${escapeHtml(item.label)}
                </span>
              `;
            })
            .join("");
      } else {
        legendBar.classList.add("hidden");
      }
    }
  }

  // ============================================================================
  // 7. REVIEW WIZARD, PNG EXPORT & MODALS
  // ============================================================================
  function exportHighResPNG() {
    if (!state) {
      alert("Please digitize a pathway figure first before exporting.");
      return;
    }

    const defaultBaseName =
      (state.title || "pathway")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "pathway_figure";

    const userFilename = window.prompt(
      "Enter a filename for the high-resolution (3x) PNG export:",
      `${defaultBaseName}_3x.png`
    );
    if (userFilename === null) return;

    const finalFilename = userFilename.trim().toLowerCase().endsWith(".png")
      ? userFilename.trim()
      : `${userFilename.trim() || defaultBaseName}.png`;

    const svg = document.getElementById("bioCanvas");
    if (!svg) return;
    const W = state.canvasWidth || 1200;
    const H = state.canvasHeight || 660;
    const scale = 3;
    const clonedSvg = svg.cloneNode(true);
    clonedSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clonedSvg.setAttribute("width", W);
    clonedSvg.setAttribute("height", H);
    clonedSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    clonedSvg.querySelectorAll(".pulse-highlight").forEach(el => el.remove());

    const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bgRect.setAttribute("x", "0");
    bgRect.setAttribute("y", "0");
    bgRect.setAttribute("width", W);
    bgRect.setAttribute("height", H);
    bgRect.setAttribute("fill", "#ffffff");
    clonedSvg.insertBefore(bgRect, clonedSvg.firstChild);

    const styleEl = document.createElementNS("http://www.w3.org/2000/svg", "style");
    styleEl.textContent = `text { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }`;
    clonedSvg.insertBefore(styleEl, clonedSvg.firstChild);

    const svgXml = new XMLSerializer().serializeToString(clonedSvg);
    const svgBlob = new Blob([svgXml], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = W * scale;
        canvas.height = H * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(url);
          alert("Failed to initialize canvas for PNG export.");
          return;
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, W, H);
        URL.revokeObjectURL(url);
        canvas.toBlob(pngBlob => {
          if (!pngBlob) {
            alert("Failed to encode PNG image blob.");
            return;
          }
          const pngUrl = URL.createObjectURL(pngBlob);
          const a = document.createElement("a");
          a.href = pngUrl;
          a.download = finalFilename;
          a.click();
          setTimeout(() => URL.revokeObjectURL(pngUrl), 1000);
        }, "image/png");
      } catch (err) {
        URL.revokeObjectURL(url);
        alert(`PNG Export Failed: ${err.message}`);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      alert("Failed to rasterize SVG diagram for PNG export.");
    };
    img.src = url;
  }

  function navigateIssue(delta) {
    if (!state || !Array.isArray(state.issues) || state.issues.length === 0) return;
    showCompletedReviewBanner = false;
    currentIssueIndex = (currentIssueIndex + delta + state.issues.length) % state.issues.length;
    renderAll();
  }

  function reopenReviewItems() {
    showCompletedReviewBanner = false;
    currentIssueIndex = 0;
    renderAll();
  }

  function renderWizardAndChangelog() {
    syncCleanUI();
    const card = document.getElementById("activeIssueCard");
    const statusRow = document.getElementById("wizardStatusRow");
    const contextBanner = document.getElementById("contextBanner");
    const modeBadge = document.getElementById("layoutModeBadge");
    if (!state || !card) return;

    contextBanner?.classList.remove("hidden");
    statusRow?.classList.remove("hidden");

    const ctxInput = document.getElementById("biologicalContextInput");
    if (ctxInput) ctxInput.value = state.biologicalContext || "";
    const sumText = document.getElementById("plausibilitySummaryText");
    if (sumText) sumText.textContent = state.plausibilitySummary || "";
    const fidBadge = document.getElementById("fidelityMetricsBadge");
    if (fidBadge) fidBadge.textContent = `${state.nodes.length} Elements • ${state.edges.length} Arrows`;

    const firstMembraneOrder =
      state.zones.find(z => z.visualStyle === "membrane_bilayer")?.order ?? 999;
    const activeZonesCount = state.zones.filter(z => {
      const isOuterOpen = z.visualStyle === "open_region" && z.order < firstMembraneOrder;
      if (isOuterOpen && !state.nodes.some(n => n.zoneId === z.id && !n.dockedTo)) return false;
      return true;
    }).length;

    if (modeBadge) {
      modeBadge.textContent = `${activeZonesCount} Cellular Zones`;
      modeBadge.className =
        "text-[11px] bg-emerald-100 text-emerald-900 border border-emerald-300 px-2 py-0.5 rounded-md font-semibold";
    }

    const pending = state.issues.filter(i => i.status === "pending");
    const counter = document.getElementById("wizardStepCounter");

    if (state.issues.length === 0) {
      if (counter) counter.textContent = "0 Items";
      card.className =
        "border border-slate-200 bg-slate-50 rounded-xl p-3.5 text-center text-xs text-slate-600";
      card.textContent = "No biological or nomenclature issues detected.";
    } else if (showCompletedReviewBanner && pending.length === 0) {
      if (counter) counter.textContent = `All ${state.issues.length} Addressed`;
      card.className =
        "border border-emerald-200 bg-emerald-50/50 rounded-xl p-3.5 text-center space-y-2";
      card.innerHTML = `
        <div class="text-emerald-800 font-bold text-sm">Scientific Review Complete</div>
        <p class="text-xs text-slate-600">All ${state.issues.length} review items have been addressed.</p>
        <button id="reopenReviewBtn" class="text-xs bg-white hover:bg-emerald-100 text-emerald-800 border border-emerald-300 px-3 py-1.5 rounded-lg font-semibold shadow-2xs transition">
          Browse All ${state.issues.length} Review Items
        </button>
      `;
      document.getElementById("reopenReviewBtn")?.addEventListener("click", reopenReviewItems);
    } else {
      currentIssueIndex = Math.max(0, Math.min(state.issues.length - 1, currentIssueIndex));
      const iss = state.issues[currentIssueIndex];
      if (counter)
        counter.textContent = `Item ${currentIssueIndex + 1} of ${state.issues.length} (${pending.length} Open)`;

      const catBadge =
        iss.category === "biological_plausibility"
          ? `<span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">Biological Plausibility</span>`
          : iss.category === "state_transition_choice"
          ? `<span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-900">State Transition</span>`
          : `<span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-rose-100 text-rose-800">Nomenclature</span>`;

      const statusPill =
        iss.status === "applied"
          ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded bg-indigo-100 text-indigo-800">✓ Applied</span>`
          : iss.status === "kept_as_is"
          ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-200 text-slate-700">Kept As Is</span>`
          : `<span class="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">Pending</span>`;

      const primaryBtnLabel =
        iss.category === "state_transition_choice" ? "Condense States" : "Apply Fix";

      card.className = "border-2 border-indigo-200 bg-indigo-50/40 rounded-xl p-3.5 space-y-2.5 text-left";
      card.innerHTML = `
        <div class="flex items-center justify-between gap-2">
          ${catBadge}
          ${statusPill}
        </div>
        <div class="text-sm font-bold text-slate-900">${escapeHtml(iss.title)}</div>
        <div>
          <span class="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">Scientific Observation</span>
          <div class="text-xs text-slate-700 leading-relaxed">${escapeHtml(iss.problemDescription)}</div>
        </div>
        <div>
          <span class="text-[10px] font-bold uppercase tracking-wider text-indigo-700 block">Proposed Action</span>
          <div class="text-xs text-slate-800 font-medium leading-relaxed">${escapeHtml(iss.proposedFixRationale)}</div>
        </div>
        <div class="flex items-center gap-2 pt-2">
          <button id="approveIssueBtn" ${
            iss.status === "applied" ? "disabled" : ""
          } class="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-xs font-bold py-2 rounded-lg shadow-sm transition">
            ${iss.status === "applied" ? "Applied" : escapeHtml(primaryBtnLabel)}
          </button>
          <button id="keepIssueBtn" class="flex-1 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 text-xs font-semibold py-2 rounded-lg transition">
            Keep As Is
          </button>
        </div>
      `;

      document.getElementById("approveIssueBtn")?.addEventListener("click", approveCurrentIssue);
      document.getElementById("keepIssueBtn")?.addEventListener("click", keepCurrentAsIs);
    }

    const logContainer = document.getElementById("changelogContainer");
    if (logContainer) {
      logContainer.innerHTML = (state.changelog || [])
        .map(
          entry => `
        <div class="p-2.5 rounded-lg border border-slate-200 bg-slate-50 text-xs leading-relaxed">
          <div class="flex justify-between items-center mb-0.5">
            <span class="font-bold text-indigo-700 uppercase text-[10px] tracking-wider">${escapeHtml(
              entry.source
            )}</span>
            <span class="text-[10px] font-mono text-slate-400">${escapeHtml(entry.time)}</span>
          </div>
          <div class="text-slate-800">${escapeHtml(entry.message)}</div>
        </div>
      `
        )
        .join("");
    }
  }

  function advanceToNextPendingOrComplete() {
    const nextPendingIdx = state.issues.findIndex(
      (iss, idx) => idx > currentIssueIndex && iss.status === "pending"
    );
    if (nextPendingIdx !== -1) {
      currentIssueIndex = nextPendingIdx;
    } else {
      const anyPending = state.issues.findIndex(iss => iss.status === "pending");
      if (anyPending !== -1) {
        currentIssueIndex = anyPending;
      } else {
        showCompletedReviewBanner = true;
      }
    }
  }

  function approveCurrentIssue() {
    if (!state) return;
    const iss = state.issues[currentIssueIndex];
    if (!iss || iss.status === "applied") return;

    const btn = document.getElementById("approveIssueBtn");
    if (btn) btn.disabled = true;

    try {
      pushUndoSnapshot();
      iss.status = "applied";
      advanceToNextPendingOrComplete();
      applyPatch(iss.patch, iss.title, iss.targetNodeIds, { skipUndo: true });
    } catch (err) {
      iss.status = "pending";
      if (btn) btn.disabled = false;
      alert(`Failed to apply fix '${iss.title}': ${err.message}`);
    }
  }

  function keepCurrentAsIs() {
    if (!state) return;
    const iss = state.issues[currentIssueIndex];
    if (!iss) return;
    pushUndoSnapshot();
    iss.status = "kept_as_is";
    appendChangelog(iss.title, "Preserved original author design choice.");
    advanceToNextPendingOrComplete();
    renderAll();
  }

  function exportRevisionHistory() {
    if (!state) return;
    const lines = [
      `BIOPATH STUDIO — PATHWAY REVISION REPORT`,
      `=========================================`,
      `Pathway Title: ${state.title}`,
      `Biological Context: ${state.biologicalContext}`,
      `Plausibility Summary: ${state.plausibilitySummary}`,
      `Current Elements: ${state.nodes.length} | Interactions: ${state.edges.length}`,
      ``,
      `REVIEW DECISIONS:`,
      ...state.issues.map(
        (iss, i) =>
          `${i + 1}. [${iss.status.toUpperCase()}] ${iss.title} (${iss.category})\n   - Observation: ${
            iss.problemDescription
          }\n   - Action: ${iss.proposedFixRationale}`
      ),
      ``,
      `CHRONOLOGICAL REVISION LOG (Newest First):`,
      ...state.changelog.map(c => `[${c.time}] ${c.source}: ${c.message}`)
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(state.title || "pathway").toLowerCase().replace(/[^a-z0-9]+/g, "_")}_revision_log.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function getSVGPoint(evt) {
    const svg = document.getElementById("bioCanvas");
    if (!svg || typeof svg.createSVGPoint !== "function") {
      return { x: evt.clientX || 0, y: evt.clientY || 0 };
    }
    const ctm = svg.getScreenCTM();
    if (!ctm) {
      return { x: evt.clientX || 0, y: evt.clientY || 0 };
    }
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    return pt.matrixTransform(ctm.inverse());
  }

  function startNodeDrag(evt, node, gElement) {
    hideHoverTooltip();
    dragTarget = node;
    dragElement = gElement;
    hasMoved = false;
    preDragSnapshot = createHistorySnapshot();
    const pt = getSVGPoint(evt);
    dragStartPt = { x: pt.x, y: pt.y };
    dragOffset = { x: pt.x - node.x, y: pt.y - node.y };
  }

  window.addEventListener("mousemove", evt => {
    if (!dragTarget || !dragElement || !state) return;
    const pt = getSVGPoint(evt);
    if (!hasMoved && Math.hypot(pt.x - dragStartPt.x, pt.y - dragStartPt.y) < 4) {
      return;
    }
    hasMoved = true;
    dragElement.classList.add("dragging");
    const W = state.canvasWidth || 1200;
    const H = state.canvasHeight || 660;
    dragTarget.x = Math.max(70, Math.min(W - 70, Math.round(pt.x - dragOffset.x)));
    dragTarget.y = Math.max(45, Math.min(H - 45, Math.round(pt.y - dragOffset.y)));
    dragElement.setAttribute("transform", `translate(${dragTarget.x}, ${dragTarget.y})`);
    renderEdgePathsOnly();
  });

  window.addEventListener("mouseup", () => {
    if (!dragTarget) return;
    if (dragElement) dragElement.classList.remove("dragging");
    if (hasMoved && preDragSnapshot && state) {
      undoStack.push(preDragSnapshot);
      redoStack = [];
      updateUndoRedoButtons();

      dragTarget.editorPosition = { x: dragTarget.x, y: dragTarget.y };
      dragTarget.pinned = true;
      if (dragTarget.layout) dragTarget.layout.pinned = true;

      appendChangelog("Manual Move", `Positioned '${dragTarget.label}' at (${dragTarget.x}, ${dragTarget.y}).`);
      renderWizardAndChangelog();
    }
    dragTarget = null;
    dragElement = null;
    preDragSnapshot = null;
    hasMoved = false;
  });

  function openNodeModal(nodeId) {
    if (!state) {
      alert("Please upload and digitize a pathway figure first.");
      return;
    }
    editingNodeId = nodeId;
    const modal = document.getElementById("nodeEditorModal");
    const zoneSelect = document.getElementById("modalZoneInput");
    if (!modal || !zoneSelect) return;
    zoneSelect.innerHTML = state.zones
      .map(z => `<option value="${escapeHtml(z.id)}">${escapeHtml(z.label)}</option>`)
      .join("");
    const node = nodeId ? state.nodes.find(n => n.id === nodeId) : null;
    const titleEl = document.getElementById("modalTitle");
    if (titleEl) titleEl.textContent = node ? `Edit '${node.label}'` : "Add Pathway Element";
    const lblInput = document.getElementById("modalLabelInput");
    if (lblInput) lblInput.value = node ? node.label : "";
    const subInput = document.getElementById("modalSubunitsInput");
    if (subInput) subInput.value = node ? (node.subunits || []).join(", ") : "";
    const modInput = document.getElementById("modalModsInput");
    if (modInput) modInput.value = node ? (node.modifications || []).join(", ") : "";
    const shapeInput = document.getElementById("modalShapeInput");
    if (shapeInput) shapeInput.value = node && VALID_SHAPES.has(node.shape) ? node.shape : "oval";
    zoneSelect.value = node ? node.zoneId : state.zones[Math.min(1, state.zones.length - 1)].id;
    const colorInput = document.getElementById("modalColorInput");
    if (colorInput) {
      colorInput.value = node && /^#[0-9A-Fa-f]{6}$/.test(node.fillColor) ? node.fillColor : "#e0f2fe";
    }
    const delBtn = document.getElementById("modalDeleteBtn");
    if (delBtn) delBtn.style.visibility = node ? "visible" : "hidden";
    modal.classList.remove("hidden");
    lblInput?.focus();
  }

  function closeNodeModal() {
    document.getElementById("nodeEditorModal")?.classList.add("hidden");
    editingNodeId = null;
  }

  function saveNodeModal() {
    if (!state) return;
    const label = document.getElementById("modalLabelInput")?.value.trim() || "";
    if (!label) {
      alert("Please enter a label.");
      return;
    }
    const subunits = (document.getElementById("modalSubunitsInput")?.value || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    const modifications = (document.getElementById("modalModsInput")?.value || "")
      .split(",")
      .map(normalizeModBadge)
      .filter(Boolean);
    const shape = document.getElementById("modalShapeInput")?.value || "oval";
    const zoneId = document.getElementById("modalZoneInput")?.value || state.zones[0].id;
    const fillColor = document.getElementById("modalColorInput")?.value || "#e0f2fe";
    applyPatch(
      {
        upsertNodes: [
          {
            id: editingNodeId || `custom_${Date.now()}`,
            label,
            subunits,
            modifications,
            shape,
            zoneId,
            fillColor
          }
        ]
      },
      editingNodeId ? "Edited Element" : "Added Element"
    );
    closeNodeModal();
  }

  function deleteNodeFromModal() {
    if (!editingNodeId) return;
    applyPatch({ removeNodeIds: [editingNodeId] }, "Deleted Element");
    closeNodeModal();
  }

  function openEdgeModal() {
    if (!state || state.nodes.length < 2) {
      alert("Please digitize a pathway with at least two elements first.");
      return;
    }
    const optionsHTML = state.nodes
      .map(n => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.label)}</option>`)
      .join("");
    const srcSel = document.getElementById("edgeSourceSelect");
    const tgtSel = document.getElementById("edgeTargetSelect");
    if (!srcSel || !tgtSel) return;
    srcSel.innerHTML = optionsHTML;
    tgtSel.innerHTML = optionsHTML;
    if (state.nodes.length > 1) tgtSel.selectedIndex = 1;
    document.getElementById("edgeEditorModal")?.classList.remove("hidden");
  }

  function closeEdgeModal() {
    document.getElementById("edgeEditorModal")?.classList.add("hidden");
  }

  function saveEdgeModal() {
    if (!state) return;
    const source = document.getElementById("edgeSourceSelect")?.value;
    const target = document.getElementById("edgeTargetSelect")?.value;
    const type = document.getElementById("edgeTypeSelect")?.value || "activates";
    if (!source || !target || source === target) {
      alert("Source and Target must be different elements.");
      return;
    }
    applyPatch(
      { upsertEdges: [{ source, target, type, label: type === "uncertain" ? "?" : "" }] },
      "Added Arrow"
    );
    closeEdgeModal();
  }

  function inspectNode(node) {
    const ctrl = document.getElementById("selectedElementControls");
    if (!ctrl || !node) return;
    ctrl.innerHTML = `
      <span class="font-bold text-indigo-700 mr-2">${escapeHtml(node.label)}:</span>
      <button id="inspectEditBtn" class="px-2.5 py-0.5 bg-white border border-slate-300 rounded text-[11px] hover:bg-slate-100 font-semibold mr-1">Edit Element</button>
      <button id="inspectDeleteBtn" class="px-2.5 py-0.5 bg-rose-50 border border-rose-200 text-rose-700 rounded text-[11px] hover:bg-rose-100 font-semibold">Delete</button>
    `;
    document.getElementById("inspectEditBtn")?.addEventListener("click", () => openNodeModal(node.id));
    document.getElementById("inspectDeleteBtn")?.addEventListener("click", () => quickDeleteNode(node.id));
  }

  function quickDeleteNode(id) {
    if (!id) return;
    applyPatch({ removeNodeIds: [id] }, "Deleted Element");
  }

  function cycleEdgePolarity(edgeIdx) {
    if (!state) return;
    const edge = state.edges[edgeIdx];
    if (!edge) return;
    const order = ["activates", "inhibits", "translocates", "uncertain"];
    const currIdx = order.indexOf(edge.type);
    const nextType = order[(currIdx + 1) % order.length];
    applyPatch(
      {
        upsertEdges: [
          {
            source: edge.source,
            target: edge.target,
            type: nextType,
            label: nextType === "uncertain" ? "?" : ""
          }
        ]
      },
      "Arrow Polarity"
    );
  }

  function showHoverTooltip(evt, node) {
    if (dragTarget || !state || !node) return;
    const tt = document.getElementById("hoverTooltip");
    if (!tt) return;
    const zoneObj = state.zones.find(z => z.id === node.zoneId);
    const ttTitle = document.getElementById("ttTitle");
    if (ttTitle) ttTitle.textContent = node.label;
    const ttComp = document.getElementById("ttCompartment");
    if (ttComp) ttComp.textContent = zoneObj ? zoneObj.label : "Pathway Element";
    const ttDesc = document.getElementById("ttDesc");
    if (ttDesc) ttDesc.textContent = node.description;
    const ttSub = document.getElementById("ttSubunits");
    const cleanSubs = normalizeSubunits(node.label, node.subunits);
    const dockedParent = node.dockedTo ? state.nodes.find(n => n.id === node.dockedTo) : null;
    if (ttSub) {
      if (dockedParent) {
        ttSub.textContent = `Physically Docked To: ${dockedParent.label}`;
      } else if (cleanSubs.length) {
        ttSub.textContent = `Subunits: ${cleanSubs.join(", ")}`;
      } else {
        ttSub.textContent = "";
      }
    }
    const nodeMap = new Map(state.nodes.map(n => [n.id, n.label]));
    const inputs = state.edges
      .filter(e => e.target === node.id)
      .map(e => `${escapeHtml(nodeMap.get(e.source) || e.source)} (${escapeHtml(e.type)})`);
    const outputs = state.edges
      .filter(e => e.source === node.id)
      .map(e => `${escapeHtml(e.type)} → ${escapeHtml(nodeMap.get(e.target) || e.target)}`);
    const ttConn = document.getElementById("ttConnections");
    if (ttConn) {
      ttConn.innerHTML = `
        <div><b>Upstream:</b> ${inputs.length ? inputs.join(", ") : dockedParent ? `Docked to ${escapeHtml(dockedParent.label)}` : "Upstream Signal"}</div>
        <div><b>Downstream:</b> ${outputs.length ? outputs.join(", ") : "Downstream Target"}</div>
      `;
    }
    tt.classList.remove("hidden");
    const viewport = document.getElementById("canvasViewport");
    const svg = document.getElementById("bioCanvas");
    if (!viewport || !svg) return;
    const svgRect = svg.getBoundingClientRect();
    const W = state.canvasWidth || 1200;
    const H = state.canvasHeight || 660;
    const nodePxX = (node.x / W) * svgRect.width;
    const nodePxY = (node.y / H) * svgRect.height;
    const ttWidth = tt.offsetWidth || 320;
    const ttHeight = tt.offsetHeight || 165;
    const left = Math.min(
      Math.max(12, nodePxX - ttWidth / 2),
      Math.max(12, viewport.clientWidth - ttWidth - 16)
    );
    const shouldFlipAbove = nodePxY + ttHeight + 48 > viewport.clientHeight;
    const top = shouldFlipAbove
      ? Math.max(12, nodePxY - ttHeight - 28)
      : Math.max(12, nodePxY + 34);
    tt.style.left = `${Math.round(left)}px`;
    tt.style.top = `${Math.round(top)}px`;
  }

  function hideHoverTooltip() {
    document.getElementById("hoverTooltip")?.classList.add("hidden");
  }

  function handleImageUpload(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      alert("Unsupported file format. Please upload a PNG, JPEG, or WebP image.");
      event.target.value = "";
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      alert("Image file exceeds the 15 MB size limit. Please choose a smaller image.");
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      const result = e.target?.result;
      if (typeof result !== "string" || !result.startsWith("data:image/")) {
        alert("Failed to read valid image data from the selected file.");
        return;
      }
      const probe = new Image();
      probe.onload = () => {
        uploadedImageBase64 = result;
        const img = document.getElementById("originalPreview");
        if (img) {
          img.src = uploadedImageBase64;
          img.classList.remove("hidden");
        }
        document.getElementById("uploadFallback")?.classList.add("hidden");
      };
      probe.onerror = () => {
        uploadedImageBase64 = null;
        alert("The selected image file appears to be corrupted and could not be decoded.");
      };
      probe.src = result;
    };
    reader.onerror = () => {
      alert("FileReader encountered an error while reading the image file.");
    };
    reader.readAsDataURL(file);
  }

  function restoreInitialExtract() {
    if (!initialDigitizedSnapshot) return;
    pushUndoSnapshot();
    state = JSON.parse(JSON.stringify(initialDigitizedSnapshot));
    computeLayout({ preservePinned: false });
    currentIssueIndex = 0;
    showCompletedReviewBanner = false;
    appendChangelog("Reset", "Restored verified baseline pathway state.");
    renderAll();
  }

  function renderAll() {
    renderWizardAndChangelog();
    renderCanvas();
  }

  window.addEventListener("DOMContentLoaded", () => {
    const savedKey =
      sessionStorage.getItem("biopath_gemini_key") ||
      localStorage.getItem("biopath_gemini_key");
    const keyInput = document.getElementById("apiKeyInput");
    if (savedKey && keyInput) keyInput.value = savedKey;
    syncCleanUI();
    renderCanvas();
  });

  return {
    handleImageUpload,
    digitizeUploadedFigure,
    restoreInitialExtract,
    navigateIssue,
    reopenReviewItems,
    approveCurrentIssue,
    keepCurrentAsIs,
    exportRevisionHistory,
    exportHighResPNG,
    undo,
    redo,
    openNodeModal,
    closeNodeModal,
    saveNodeModal,
    deleteNodeFromModal,
    openEdgeModal,
    closeEdgeModal,
    saveEdgeModal,
    quickDeleteNode,
    handleNaturalLanguagePrompt,
    saveApiKey
  };
})();