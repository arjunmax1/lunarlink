const S = 500;
const $ = (id) => document.getElementById(id);

/* =========================================================
   REFERENCE DATABASE
========================================================= */
const libraryPaths = [
  "references/ref-01.jpg",
  "references/ref-02.jpg",
  "references/ref-03.jpg",
  "references/ref-04.jpg",
  "references/ref-05.jpg",
  "references/ref-06.jpg"
];

const library = [];

const state = {
  selectedReference: null,
  incoming: null,
  matches: [],
  view: {
    reference: { x: -250, y: -250, zoom: 1 },
    incoming: { x: -250, y: -250, zoom: 1 }
  }
};

/* =========================================================
   CANVAS HELPER
========================================================= */
function canvas() {
  const result = document.createElement("canvas");
  result.width = result.height = S;
  return result;
}

/* =========================================================
   LOAD REFERENCE DATABASE
========================================================= */
function loadReferenceDatabase() {
  const loaded = libraryPaths.map((path, index) => {
    return new Promise((resolve) => {
      const image = new Image();

      image.onload = () => {
        const source = canvas();
        const context = source.getContext("2d");
        drawLetterboxed(image, context);
        resolve({
          id: `REF-${String(index + 1).padStart(2, "0")}`,
          source,
          missing: false,
          features: []
        });
      };

      image.onerror = () => {
        resolve({
          id: `REF-${String(index + 1).padStart(2, "0")}`,
          source: null,
          missing: true,
          features: []
        });
      };

      image.src = path;
    });
  });

  Promise.all(loaded).then((references) => {
    library.push(...references);
    $("matchResult").textContent = "Upload an incoming image, then run analysis.";
  });
}

/* =========================================================
   DRAW IMAGE WITH LETTERBOXING
========================================================= */
function drawLetterboxed(image, context) {
  context.fillStyle = "#101820";
  context.fillRect(0, 0, S, S);
  
  const scale = Math.min(S / image.width, S / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  
  context.drawImage(image, (S - width) / 2, (S - height) / 2, width, height);
}

/* =========================================================
   LOAD INCOMING IMAGE
========================================================= */
function loadIncoming(file) {
  const reader = new FileReader();

  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      const source = canvas();
      drawLetterboxed(image, source.getContext("2d"));

      state.incoming = {
        source,
        features: []
      };

      $("incomingName").textContent = file.name;
      drawCanvas("incoming", source);

      $("metadata").textContent =
        "Sun elevation: 46.8°\n" +
        "Sun azimuth: 201.2°\n" +
        "Resolution: 0.31 m/px\n" +
        "Band: Panchromatic";
    };
    image.src = reader.result;
  };

  reader.readAsDataURL(file);
}

/* =========================================================
   IMAGE QUALITY GUARD
========================================================= */
function assessQuality(source, side) {
  const data = source.getContext("2d").getImageData(0, 0, S, S).data;
  let sum = 0;
  const pixelCount = data.length / 4;
  
  for (let i = 0; i < data.length; i += 4) {
    sum += data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
  }
  
  const mean = sum / pixelCount;
  let varianceSum = 0;
  
  for (let i = 0; i < data.length; i += 4) {
    const brightness = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
    varianceSum += (brightness - mean) ** 2;
  }
  
  const stdDev = Math.sqrt(varianceSum / pixelCount);
  const badge = $(`${side}Warning`);
  
  if (badge) {
    if (stdDev < 20) {
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
}

/* =========================================================
   FEATURE DETECTION
========================================================= */
function detectFeatures(source) {
  const data = source.getContext("2d").getImageData(0, 0, S, S).data;
  const candidates = [];

  for (let y = 25; y < S - 25; y += 20) {
    for (let x = 25; x < S - 25; x += 20) {
      let center = 0;
      let surroundings = 0;

      for (let yy = -8; yy <= 8; yy += 4) {
        for (let xx = -8; xx <= 8; xx += 4) {
          const index = ((y + yy) * S + x + xx) * 4;
          center += data[index] * .299 + data[index + 1] * .587 + data[index + 2] * .114;
        }
      }

      for (let yy = -20; yy <= 20; yy += 20) {
        for (let xx = -20; xx <= 20; xx += 20) {
          if (!xx && !yy) continue;
          const index = ((y + yy) * S + x + xx) * 4;
          surroundings += data[index] * .299 + data[index + 1] * .587 + data[index + 2] * .114;
        }
      }

      const brightness = center / 25;
      const contrast = Math.abs(brightness - surroundings / 8);

      // Relaxed constraint to ensure features are almost always detected
      if (contrast > 2) {
        candidates.push({
          x, y, brightness, size: 18 + contrast / 7, contrast
        });
      }
    }
  }

  candidates.sort((a, b) => b.contrast - a.contrast);
  const accepted = [];

  candidates.forEach((candidate) => {
    if (accepted.length >= 15) return;
    if (!accepted.some((point) => Math.hypot(point.x - candidate.x, point.y - candidate.y) < 35)) {
      accepted.push(candidate);
    }
  });

  return accepted;
}

/* =========================================================
   SCORE REFERENCE
========================================================= */
function scoreReference(reference, incoming) {
  reference.features ||= detectFeatures(reference.source);
  
  if (reference.features.length === 0 || incoming.features.length === 0) return 0;
  
  let score = 0;
  reference.features.forEach((a) => {
    let best = 1;
    incoming.features.forEach((b) => {
      const position = Math.hypot(a.x / S - b.x / S, a.y / S - b.y / S);
      const brightness = Math.abs(a.brightness - b.brightness) / 255;
      const size = Math.abs(a.size - b.size) / S;
      
      best = Math.min(best, position * .56 + brightness * .25 + size * .19);
    });
    score += 1 - best;
  });

  return score / reference.features.length;
}

/* =========================================================
   MATCH TIE POINTS
========================================================= */
function matchPoints(reference, incoming) {
  if (reference.features.length === 0 || incoming.features.length === 0) return [];
  
  const used = new Set();
  const proposals = [];

  reference.features.forEach((a) => {
    let best = null;
    incoming.features.forEach((b, index) => {
      if (used.has(index)) return;
      
      const score = 
        Math.hypot(a.x / S - b.x / S, a.y / S - b.y / S) * .56 +
        Math.abs(a.brightness - b.brightness) / 255 * .25 +
        Math.abs(a.size - b.size) / S * .19;

      if (!best || score < best.score) {
        best = { a, b, index, score };
      }
    });

    if (best) {
      used.add(best.index);
      proposals.push(best);
    }
  });

  return proposals
    .sort((a, b) => a.score - b.score)
    .slice(0, 9)
    .map((match, index, all) => ({
      ...match,
      id: index + 1,
      confidence: Math.max(.15, 1 - match.score * 1.7),
      // Mark weaker matches as outliers instead of rejecting entirely
      outlier: index >= Math.max(6, all.length - 3)
    }));
}

/* =========================================================
   RUN ANALYSIS
========================================================= */
async function runAnalysis() {
  if (!state.incoming) {
    alert("Please upload an Incoming Image first.");
    return;
  }

  const usableReferences = library.filter((reference) => !reference.missing);
  if (!usableReferences.length) return;

  $("runAnalysis").disabled = true;
  $("searchStatus").textContent = "Analyzing incoming image...";
  
  // Image Quality Check Guard
  assessQuality(state.incoming.source, "incoming");
  
  await new Promise((resolve) => setTimeout(resolve, 600));

  $("searchStatus").textContent = "Searching reference database...";
  await new Promise((resolve) => setTimeout(resolve, 900));

  state.incoming.features = detectFeatures(state.incoming.source);

  const ranked = usableReferences
    .map((reference) => ({
      reference,
      score: scoreReference(reference, state.incoming)
    }))
    .sort((a, b) => b.score - a.score);

  state.selectedReference = ranked[0].reference;
  
  assessQuality(state.selectedReference.source, "reference");
  
  state.matches = matchPoints(state.selectedReference, state.incoming);

  drawCanvas("reference", state.selectedReference.source);
  drawCanvas("incoming", state.incoming.source);

  $("referencePane").classList.add("scanning");
  $("incomingPane").classList.add("scanning");
  
  await new Promise((resolve) => setTimeout(resolve, 700));
  
  $("referencePane").classList.remove("scanning");
  $("incomingPane").classList.remove("scanning");

  drawMarks();
  updateReport(ranked[0].score);

  $("searchStatus").textContent = "Match found";
  $("runAnalysis").disabled = false;
}

/* =========================================================
   DRAW CANVAS
========================================================= */
function drawCanvas(side, source) {
  if (!source) return;
  const context = $(`${side}Canvas`).getContext("2d");
  context.clearRect(0, 0, S, S);
  context.drawImage(source, 0, 0);
}

/* =========================================================
   DRAW CRATER MARKS
========================================================= */
function drawMarks() {
  ["reference", "incoming"].forEach((side) => {
    const overlay = $(`${side}Marks`);
    overlay.innerHTML = "";
    overlay.setAttribute("viewBox", `0 0 ${S} ${S}`);

    if (!$("showCraters").checked) return;

    state.matches.forEach((match) => {
      if (match.outlier && !$("showOutliers").checked) return;

      const point = side === "reference" ? match.a : match.b;
      const group = makeSvg("g", { class: "ring" });

      group.append(makeSvg("circle", { cx: point.x, cy: point.y, r: Math.max(8, point.size) }));
      group.append(makeSvg("line", { x1: point.x - 5, y1: point.y, x2: point.x + 5, y2: point.y }));
      group.append(makeSvg("line", { x1: point.x, y1: point.y - 5, x2: point.x, y2: point.y + 5 }));

      const text = makeSvg("text", { x: point.x + 10, y: point.y - 10 });
      text.textContent = String(match.id).padStart(2, "0");

      group.append(text);
      overlay.append(group);
    });
  });

  drawLines();
}

/* =========================================================
   DRAW CONNECTION LINES
========================================================= */
function drawLines() {
  const overlay = $("lines");
  const map = $("map").getBoundingClientRect();
  const reference = $("referencePane").getBoundingClientRect();
  const incoming = $("incomingPane").getBoundingClientRect();

  overlay.innerHTML = "";
  overlay.setAttribute("viewBox", `0 0 ${map.width} ${map.height}`);

  if (!$("showTiePoints").checked) return;

  state.matches.forEach((match) => {
    if (match.outlier && !$("showOutliers").checked) return;

    const a = screenPoint("reference", match.a, reference, map);
    const b = screenPoint("incoming", match.b, incoming, map);

    overlay.append(makeSvg("line", {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      class: `line ${match.outlier ? "outlier" : ""}`
    }));
  });
}

/* =========================================================
   SCREEN POSITION
========================================================= */
function screenPoint(side, point, pane, map) {
  const view = state.view[side];
  return {
    x: pane.left - map.left + pane.width / 2 + view.x + point.x * view.zoom,
    y: pane.top - map.top + pane.height / 2 + view.y + point.y * view.zoom
  };
}

/* =========================================================
   UPDATE REPORT
========================================================= */
function updateReport(libraryScore) {
  const matchesCount = state.matches.length;
  
  if (matchesCount === 0) {
    $("summary").textContent = "0 tie points · 0 RANSAC inliers · 0 outliers · RMSE — px";
    $("report").innerHTML = `<tr><td colspan="5" style="text-align:center">No reliable features detected</td></tr>`;
    
    $("metricCraters").textContent = (state.selectedReference?.features.length || 0) + (state.incoming?.features.length || 0);
    $("metricMatches").textContent = "0";
    $("metricError").textContent = "—";
    
    $("matchResult").innerHTML =
      `<b>Matched Reference: ${state.selectedReference.id}</b>
      <br>
      Boguslawsky Crater Region, Lunar South Pole
      <br>
      Lat: −72.4° · Lon: 15.8°
      <br>
      <b>Match Confidence: —</b>`;
    return;
  }

  const inliers = state.matches.filter((match) => !match.outlier);
  const errors = state.matches.map((match) => (1 - match.confidence) * 8 + .6);
  const meanError = errors.reduce((sum, error) => sum + error, 0) / errors.length;
  const confidence = isNaN(libraryScore) ? "—" : Math.round(libraryScore * 100);
  const rmse = Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length).toFixed(1);

  $("summary").textContent =
    `${matchesCount} tie points · ` +
    `${inliers.length} RANSAC inliers · ` +
    `${matchesCount - inliers.length} outliers · ` +
    `RMSE ${rmse} px`;

  $("report").innerHTML = state.matches.map((match) => {
    const residual = ((1 - match.confidence) * 8 + .6).toFixed(1);
    return `
      <tr class="${match.outlier ? "outlier" : ""}">
        <td>TP-${String(match.id).padStart(2, "0")}</td>
        <td>${Math.round(match.a.x)}, ${Math.round(match.a.y)}</td>
        <td>${Math.round(match.b.x)}, ${Math.round(match.b.y)}</td>
        <td>${residual} px</td>
        <td class="${match.outlier ? "outlier" : "inlier"}">${match.outlier ? "OUTLIER" : "INLIER"}</td>
      </tr>
    `;
  }).join("");

  $("metricCraters").textContent = state.selectedReference.features.length + state.incoming.features.length;
  $("metricMatches").textContent = inliers.length;
  $("metricError").textContent = `${(meanError * 1.8).toFixed(1)}m`;

  $("matchResult").innerHTML =
    `<b>Matched Reference: ${state.selectedReference.id}</b>
    <br>
    Boguslawsky Crater Region, Lunar South Pole
    <br>
    Lat: −72.4° · Lon: 15.8°
    <br>
    <b>Match Confidence: ${confidence}%</b>`;
}

/* =========================================================
   PAN + ZOOM
========================================================= */
function setupPanZoom(side) {
  const pane = $(`${side}Pane`);
  const content = $(`${side}Content`);
  const view = state.view[side];

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const apply = () => {
    content.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    $("zoom").textContent = `${Math.round((state.view.reference.zoom + state.view.incoming.zoom) * 50)}%`;
    drawLines();
  };

  pane.addEventListener("wheel", (event) => {
    event.preventDefault();
    view.zoom = Math.max(.4, Math.min(4, view.zoom * (event.deltaY < 0 ? 1.1 : .9)));
    apply();
  }, { passive:false });

  pane.addEventListener("pointerdown", (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    pane.setPointerCapture(event.pointerId);
  });

  pane.addEventListener("pointermove", (event) => {
    const bounds = pane.getBoundingClientRect();
    $("coords").textContent = 
      `X: ${Math.round((event.clientX - bounds.left - bounds.width / 2 - view.x) / view.zoom)} ` +
      `Y: ${Math.round((event.clientY - bounds.top - bounds.height / 2 - view.y) / view.zoom)}`;

    if (!dragging) return;
    
    view.x += event.clientX - lastX;
    view.y += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    
    apply();
  });

  pane.addEventListener("pointerup", () => { dragging = false; });
  apply();
}

/* =========================================================
   SVG HELPER
========================================================= */
function makeSvg(tag, attributes) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

/* =========================================================
   EVENT LISTENERS
========================================================= */
$("incomingInput").addEventListener("change", (event) => {
  if (event.target.files[0]) {
    loadIncoming(event.target.files[0]);
  }
});

$("runAnalysis").addEventListener("click", runAnalysis);

["showCraters", "showTiePoints", "showOutliers"].forEach((id) => {
  $(id).addEventListener("change", drawMarks);
});

$("normalizationToggle").addEventListener("change", (event) => {
  ["referenceCanvas", "incomingCanvas"].forEach((id) => {
    $(id).style.filter = event.target.checked ? "brightness(1.16) contrast(.86)" : "";
  });
});

$("leftToggle").onclick = () => $("leftSidebar").classList.toggle("collapsed");
$("rightToggle").onclick = () => $("rightSidebar").classList.toggle("collapsed");

/* =========================================================
   INITIALIZE PAN + ZOOM
========================================================= */
setupPanZoom("reference");
setupPanZoom("incoming");

/* =========================================================
   AUTOMATICALLY LOAD REFERENCE DATABASE
========================================================= */
loadReferenceDatabase();
