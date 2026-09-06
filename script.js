const DISPLAY_SIZE = 500;
const GRID_SIZE = 20;
const MAX_FEATURES = 15;
const MAX_MATCHES = 9;

const instrumentSelect = document.getElementById("instrument");
const runButton = document.getElementById("runAnalysis");
const pipelineSteps = [...document.querySelectorAll(".pipeline-step")];
const resultsSection = document.getElementById("resultsSection");
const accuracySection = document.getElementById("accuracySection");
const metricsSection = document.getElementById("metricsSection");
const normalizationToggle = document.getElementById("normalizationToggle");
const overlay = document.getElementById("correspondenceOverlay");
const scanLine = document.getElementById("scanLine");
const tooltip = document.getElementById("matchTooltip");
const accuracyTableBody = document.getElementById("accuracyTableBody");

const detectedMetadata = { A: null, B: null };
const uploaded = { A: false, B: false };
let metricsHaveAnimated = false;
let detectedFeatures = { A: [], B: [] };
let activeMatches = [];

/* Used only when one or both images have not been uploaded. */
const baseTiePoints = [
  [72, 82, 31], [177, 71, 18], [292, 104, 46],
  [109, 198, 49], [245, 212, 31], [339, 264, 19],
  [58, 312, 39], [181, 326, 24], [286, 344, 38]
];

const fallbackTransform = {
  rotation: 9 * Math.PI / 180,
  scale: 0.94,
  skewX: 0.075,
  translateX: 9,
  translateY: -6
};

const uploadBoxes = [
  {
    id: "A",
    box: document.getElementById("uploadBoxA"),
    input: document.getElementById("imageAInput"),
    name: document.getElementById("fileNameA"),
    canvas: document.getElementById("canvasA"),
    loading: document.getElementById("metadataLoadingA"),
    card: document.getElementById("metadataCardA")
  },
  {
    id: "B",
    box: document.getElementById("uploadBoxB"),
    input: document.getElementById("imageBInput"),
    name: document.getElementById("fileNameB"),
    canvas: document.getElementById("canvasB"),
    loading: document.getElementById("metadataLoadingB"),
    card: document.getElementById("metadataCardB")
  }
];

uploadBoxes.forEach((item) => {
  item.box.addEventListener("click", () => item.input.click());

  item.input.addEventListener("change", () => {
    const file = item.input.files[0];
    if (!file) return;

    item.name.textContent = file.name;
    loadUploadedImage(file, item.id);
  });

  ["dragenter", "dragover"].forEach((type) => {
    item.box.addEventListener(type, (event) => {
      event.preventDefault();
      item.box.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((type) => {
    item.box.addEventListener(type, (event) => {
      event.preventDefault();
      item.box.classList.remove("drag-over");
    });
  });

  item.box.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files[0];
    if (!file || !file.type.startsWith("image/")) return;

    item.name.textContent = file.name;
    loadUploadedImage(file, item.id);
  });
});

instrumentSelect.addEventListener("change", () => {
  if (detectedMetadata.A) extractMetadata("A");
  if (detectedMetadata.B) extractMetadata("B");
});

normalizationToggle.addEventListener("change", () => {
  uploadBoxes.forEach(({ canvas }) => {
    canvas.classList.toggle("normalized", normalizationToggle.checked);
  });
});

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  runButton.textContent = "Analysis in Progress…";

  [resultsSection, accuracySection, metricsSection].forEach((section) => {
    section.classList.remove("visible");
  });

  pipelineSteps.forEach((step) => step.classList.remove("active"));
  overlay.innerHTML = "";

  for (let index = 0; index < pipelineSteps.length; index += 1) {
    pipelineSteps[index].classList.add("active");

    if (index === 1 && (detectedMetadata.A || detectedMetadata.B)) {
      normalizationToggle.checked = true;
      uploadBoxes.forEach(({ canvas }) => canvas.classList.add("normalized"));
    }

    if (index === 2 && uploaded.A && uploaded.B) {
      detectedFeatures.A = detectFeatures(canvasA);
      detectedFeatures.B = detectFeatures(canvasB);
    }

    if (index === 4) {
      activeMatches = uploaded.A && uploaded.B
        ? matchUploadedFeatures(detectedFeatures.A, detectedFeatures.B)
        : createFallbackMatches();
    }

    await delay(430);
  }

  resultsSection.classList.add("visible");
  await delay(250);

  scanLine.classList.remove("scanning");
  void scanLine.offsetWidth;
  scanLine.classList.add("scanning");

  await delay(850);

  drawTargetingOverlay(activeMatches);
  updateAccuracyReport(activeMatches);

  accuracySection.classList.add("visible");
  metricsSection.classList.add("visible");
  animateMetrics();

  runButton.disabled = false;
  runButton.textContent = "Run Correspondence Analysis";
});

function loadUploadedImage(file, imageId) {
  const reader = new FileReader();

  reader.onload = (event) => {
    const image = new Image();

    image.onload = () => {
      drawImageLetterboxed(image, imageId === "A" ? canvasA : canvasB);
      uploaded[imageId] = true;
      extractMetadata(imageId);
    };

    image.src = event.target.result;
  };

  reader.readAsDataURL(file);
}

function drawImageLetterboxed(image, canvas) {
  const context = canvas.getContext("2d");
  canvas.width = DISPLAY_SIZE;
  canvas.height = DISPLAY_SIZE;

  context.fillStyle = "#101419";
  context.fillRect(0, 0, DISPLAY_SIZE, DISPLAY_SIZE);

  const scale = Math.min(DISPLAY_SIZE / image.width, DISPLAY_SIZE / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const x = (DISPLAY_SIZE - width) / 2;
  const y = (DISPLAY_SIZE - height) / 2;

  context.drawImage(image, x, y, width, height);
  canvas.dataset.hasImage = "true";
}

/*
  Simple local-contrast blob detector:
  - Convert each grid block to average brightness.
  - Compare it to its 8 neighboring blocks.
  - Retain the strongest local bright/dark deviations.
*/
function detectFeatures(canvas) {
  const context = canvas.getContext("2d");
  const imageData = context.getImageData(0, 0, DISPLAY_SIZE, DISPLAY_SIZE);
  const columns = Math.floor(DISPLAY_SIZE / GRID_SIZE);
  const rows = Math.floor(DISPLAY_SIZE / GRID_SIZE);
  const cells = [];

  for (let row = 0; row < rows; row += 1) {
    cells[row] = [];

    for (let column = 0; column < columns; column += 1) {
      let brightnessSum = 0;
      let pixels = 0;

      for (let y = row * GRID_SIZE; y < (row + 1) * GRID_SIZE; y += 1) {
        for (let x = column * GRID_SIZE; x < (column + 1) * GRID_SIZE; x += 1) {
          const offset = (y * DISPLAY_SIZE + x) * 4;
          brightnessSum += (
            imageData.data[offset] * 0.299 +
            imageData.data[offset + 1] * 0.587 +
            imageData.data[offset + 2] * 0.114
          );
          pixels += 1;
        }
      }

      cells[row][column] = brightnessSum / pixels;
    }
  }

  const candidates = [];

  for (let row = 1; row < rows - 1; row += 1) {
    for (let column = 1; column < columns - 1; column += 1) {
      const localValue = cells[row][column];
      const neighbors = [];

      for (let y = row - 1; y <= row + 1; y += 1) {
        for (let x = column - 1; x <= column + 1; x += 1) {
          if (x !== column || y !== row) neighbors.push(cells[y][x]);
        }
      }

      const neighborhoodAverage = neighbors.reduce((sum, value) => sum + value, 0) / neighbors.length;
      const signedContrast = localValue - neighborhoodAverage;
      const contrast = Math.abs(signedContrast);

      if (contrast < 10) continue;

      let similarNeighborCount = 0;

      neighbors.forEach((value) => {
        const neighborContrast = value - neighborhoodAverage;
        if (
          Math.sign(neighborContrast) === Math.sign(signedContrast) &&
          Math.abs(neighborContrast) > contrast * 0.4
        ) {
          similarNeighborCount += 1;
        }
      });

      candidates.push({
        x: column * GRID_SIZE + GRID_SIZE / 2,
        y: row * GRID_SIZE + GRID_SIZE / 2,
        brightness: localValue,
        contrast,
        size: GRID_SIZE * (1 + similarNeighborCount * 0.14),
        polarity: Math.sign(signedContrast)
      });
    }
  }

  candidates.sort((first, second) => second.contrast - first.contrast);

  const selected = [];

  candidates.forEach((candidate) => {
    const tooClose = selected.some((feature) => {
      return Math.hypot(feature.x - candidate.x, feature.y - candidate.y) < GRID_SIZE * 1.8;
    });

    if (!tooClose && selected.length < MAX_FEATURES) selected.push(candidate);
  });

  return selected;
}

/*
  Feature matching uses:
  - relative x/y position within each image,
  - local brightness,
  - estimated feature size.
*/
function matchUploadedFeatures(featuresA, featuresB) {
  const proposals = [];

  featuresA.forEach((featureA, indexA) => {
    let best = null;

    featuresB.forEach((featureB, indexB) => {
      const positionDistance = Math.hypot(
        featureA.x / DISPLAY_SIZE - featureB.x / DISPLAY_SIZE,
        featureA.y / DISPLAY_SIZE - featureB.y / DISPLAY_SIZE
      );

      const brightnessDistance = Math.abs(featureA.brightness - featureB.brightness) / 255;
      const sizeDistance = Math.abs(featureA.size - featureB.size) / DISPLAY_SIZE;
      const polarityPenalty = featureA.polarity === featureB.polarity ? 0 : 0.1;

      const distance =
        positionDistance * 0.56 +
        brightnessDistance * 0.25 +
        sizeDistance * 0.19 +
        polarityPenalty;

      if (!best || distance < best.distance) {
        best = { indexA, indexB, featureA, featureB, distance };
      }
    });

    if (best) proposals.push(best);
  });

  const mutual = proposals.filter((proposal) => {
    const bestForB = proposals
      .filter((other) => other.indexB === proposal.indexB)
      .sort((first, second) => first.distance - second.distance)[0];

    return bestForB && bestForB.indexA === proposal.indexA;
  });

  const pairs = (mutual.length >= 6 ? mutual : proposals)
    .sort((first, second) => first.distance - second.distance)
    .slice(0, MAX_MATCHES);

  return pairs.map((pair, index) => {
    const similarity = Math.max(0.15, 1 - pair.distance * 1.7);
    const confidence = Math.round(similarity * 100);
    const residualMeters = Number((1.1 + (1 - similarity) * 15).toFixed(1));

    return {
      id: String(index + 1).padStart(2, "0"),
      a: pair.featureA,
      b: pair.featureB,
      confidence: `${confidence}%`,
      residual: `${residualMeters.toFixed(1)}m`,
      similarity,
      outlier: false
    };
  }).map((match, index, matches) => ({
    ...match,
    outlier: index >= Math.max(6, matches.length - 3)
  }));
}

function createFallbackMatches() {
  return baseTiePoints.map(([x, y, radius], index) => {
    const transformed = transformFallbackPoint(x, y, radius);
    const isOutlier = index >= 6;

    return {
      id: String(index + 1).padStart(2, "0"),
      a: { x, y, size: radius },
      b: isOutlier
        ? { x: [330, 62, 225][index - 6], y: [70, 120, 45][index - 6], size: radius }
        : { x: transformed.x, y: transformed.y, size: transformed.r },
      confidence: `${[96, 91, 87, 78, 89, 84, 31, 24, 38][index]}%`,
      residual: `${[1.5, 2.1, 2.8, 5.1, 2.5, 2.0, 12.4, 14.8, 10.7][index]}m`,
      similarity: [0.96, 0.91, 0.87, 0.78, 0.89, 0.84, 0.31, 0.24, 0.38][index],
      outlier: isOutlier
    };
  });
}

function transformFallbackPoint(x, y, radius) {
  const { rotation, scale, skewX, translateX, translateY } = fallbackTransform;
  const cos = Math.cos(rotation) * scale;
  const sin = Math.sin(rotation) * scale;
  const dx = x - 200;
  const dy = y - 200;

  return {
    x: 200 + translateX + cos * dx + (-sin + skewX) * dy,
    y: 200 + translateY + sin * dx + cos * dy,
    r: radius * scale
  };
}

function drawTargetingOverlay(matches) {
  overlay.innerHTML = "";

  const stageBounds = resultsStage.getBoundingClientRect();
  const canvasABounds = canvasA.getBoundingClientRect();
  const canvasBBounds = canvasB.getBoundingClientRect();

  overlay.setAttribute("viewBox", `0 0 ${stageBounds.width} ${stageBounds.height}`);

  matches.forEach((match) => {
    const pointA = mapToStage(match.a, canvasABounds, stageBounds);
    const pointB = mapToStage(match.b, canvasBBounds, stageBounds);

    overlay.append(svg("line", {
      x1: pointA.x,
      y1: pointA.y,
      x2: pointB.x,
      y2: pointB.y,
      class: "match-line",
      "data-match": match.id
    }));

    overlay.append(createReticle(pointA, match, "A"));
    overlay.append(createReticle(pointB, match, "B"));
  });
}

function mapToStage(point, canvasBounds, stageBounds) {
  return {
    x: canvasBounds.left - stageBounds.left + canvasBounds.width * (point.x / DISPLAY_SIZE),
    y: canvasBounds.top - stageBounds.top + canvasBounds.height * (point.y / DISPLAY_SIZE),
    r: canvasBounds.width * ((point.size || GRID_SIZE) / DISPLAY_SIZE)
  };
}

function createReticle(point, match, side) {
  const group = svg("g", {
    class: "target-ring",
    "data-match": match.id,
    "data-side": side
  });

  const radius = Math.max(8, point.r);

  group.append(svg("circle", { cx: point.x, cy: point.y, r: radius }));

  [
    [point.x, point.y - radius - 7, point.x, point.y - radius - 2],
    [point.x, point.y + radius + 2, point.x, point.y + radius + 7],
    [point.x - radius - 7, point.y, point.x - radius - 2, point.y],
    [point.x + radius + 2, point.y, point.x + radius + 7, point.y]
  ].forEach(([x1, y1, x2, y2]) => {
    group.append(svg("line", { x1, y1, x2, y2 }));
  });

  const labelX = point.x + radius + 7;
  const labelY = point.y - radius - 4;

  group.append(svg("rect", { x: labelX, y: labelY, width: 21, height: 13, rx: 2 }));

  const label = svg("text", {
    x: labelX + 10.5,
    y: labelY + 9.5,
    "text-anchor": "middle"
  });

  label.textContent = match.id;
  group.append(label);

  group.addEventListener("mouseenter", (event) => focusMatch(match, event));
  group.addEventListener("mousemove", moveTooltip);
  group.addEventListener("mouseleave", clearFocus);

  return group;
}

function updateAccuracyReport(matches) {
  const inliers = matches.filter((match) => !match.outlier);
  const outliers = matches.filter((match) => match.outlier);

  document.querySelector(".summary-stat:nth-child(1) strong").textContent = matches.length;
  document.querySelector(".summary-stat:nth-child(2) strong").textContent = inliers.length;
  document.querySelector(".summary-stat:nth-child(3) strong").textContent = outliers.length;

  accuracyTableBody.innerHTML = matches.map((match, index) => {
    const residualPixels = Number(((1 - match.similarity) * 8 + 0.6).toFixed(1));
    const residualMeters = Number((residualPixels * 1.8).toFixed(1));
    const lunarLatitude = (-14.12 - (match.a.y / DISPLAY_SIZE) * 0.7).toFixed(3);
    const lunarLongitude = (61.84 + (match.a.x / DISPLAY_SIZE) * 0.9).toFixed(3);

    return `
      <tr class="${match.outlier ? "outlier-row" : ""}">
        <td>TP-${match.id}</td>
        <td>${Math.round(match.a.x)}, ${Math.round(match.a.y)}</td>
        <td>${Math.round(match.b.x)}, ${Math.round(match.b.y)}</td>
        <td>${lunarLatitude}°, ${lunarLongitude}°</td>
        <td>${residualPixels} px</td>
        <td>${residualMeters} m</td>
        <td><span class="status-badge ${match.outlier ? "outlier" : "inlier"}">${match.outlier ? "Outlier" : "Inlier"}</span></td>
      </tr>
    `;
  }).join("");
}

function focusMatch(match, event) {
  overlay.querySelectorAll("[data-match]").forEach((element) => element.classList.add("hud-dim"));

  overlay.querySelectorAll(`[data-match="${match.id}"]`).forEach((element) => {
    element.classList.remove("hud-dim");
    element.classList.add("hud-highlight");
  });

  tooltip.textContent = `Match Confidence: ${match.confidence} · Residual: ${match.residual}`;
  tooltip.classList.add("visible");
  moveTooltip(event);
}

function moveTooltip(event) {
  const bounds = resultsStage.getBoundingClientRect();
  tooltip.style.left = `${event.clientX - bounds.left + 14}px`;
  tooltip.style.top = `${event.clientY - bounds.top + 14}px`;
}

function clearFocus() {
  overlay.querySelectorAll("[data-match]").forEach((element) => {
    element.classList.remove("hud-dim", "hud-highlight");
  });

  tooltip.classList.remove("visible");
}

function extractMetadata(imageId) {
  const item = uploadBoxes.find((upload) => upload.id === imageId);

  item.card.classList.remove("visible");
  item.loading.classList.add("visible");

  setTimeout(() => {
    const metadata = getMetadata(imageId, instrumentSelect.value);
    detectedMetadata[imageId] = metadata;

    Object.entries(metadata).forEach(([key, value]) => {
      const field = document.getElementById(`${key}${imageId}`);
      if (field) field.textContent = value;
    });

    item.loading.classList.remove("visible");
    item.card.classList.add("visible");
  }, 800);
}

function getMetadata(id, instrument) {
  const isA = id === "A";

  const sensor = {
    OHRC: { resolution: isA ? "0.28 m/px" : "0.31 m/px", spectralBand: "Panchromatic" },
    "TMC-2": { resolution: isA ? "5.1 m/px" : "5.3 m/px", spectralBand: "Panchromatic" },
    IIRS: { resolution: isA ? "81 m/px" : "79 m/px", spectralBand: "VNIR 0.8–3.0µm" }
  }[instrument];

  return {
    sunElevation: isA ? "42.3°" : "46.8°",
    sunAzimuth: isA ? "187.6°" : "201.2°",
    resolution: sensor.resolution,
    spectralBand: sensor.spectralBand,
    viewingAngle: isA ? "+12.4° off-nadir" : "+8.7° off-nadir"
  };
}

function svg(name, attributes) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function animateMetrics() {
  if (metricsHaveAnimated) return;
  metricsHaveAnimated = true;

  document.querySelectorAll(".metric-value").forEach((metric) => {
    const target = Number(metric.dataset.target);
    const decimals = Number(metric.dataset.decimals || 0);
    const suffix = metric.dataset.suffix || "";
    const start = performance.now();

    function tick(now) {
      const progress = Math.min((now - start) / 1000, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      metric.textContent = `${(target * eased).toFixed(decimals)}${suffix}`;
      if (progress < 1) requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  });
}

function drawFallbackSurface(canvas, variation) {
  const context = canvas.getContext("2d");
  canvas.width = DISPLAY_SIZE;
  canvas.height = DISPLAY_SIZE;

  const surface = context.createRadialGradient(160, 100, 10, 250, 250, 520);
  surface.addColorStop(0, variation ? "#9aa1a8" : "#a9afb5");
  surface.addColorStop(.52, variation ? "#505860" : "#5f676f");
  surface.addColorStop(1, "#20262c");

  context.fillStyle = surface;
  context.fillRect(0, 0, DISPLAY_SIZE, DISPLAY_SIZE);

  baseTiePoints.forEach(([x, y, radius]) => {
    const scale = DISPLAY_SIZE / 400;
    const crater = context.createRadialGradient(
      x * scale - radius * scale * .24,
      y * scale - radius * scale * .28,
      radius * scale * .08,
      x * scale,
      y * scale,
      radius * scale
    );

    crater.addColorStop(0, "rgba(24,29,34,.96)");
    crater.addColorStop(.65, "rgba(42,49,55,.82)");
    crater.addColorStop(.8, "rgba(170,175,178,.42)");
    crater.addColorStop(1, "transparent");

    context.fillStyle = crater;
    context.beginPath();
    context.arc(x * scale, y * scale, radius * scale, 0, Math.PI * 2);
    context.fill();
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/* Demo fallback remains available until the user uploads both real images. */
drawFallbackSurface(canvasA, false);
drawFallbackSurface(canvasB, true);
extractMetadata("A");
extractMetadata("B");