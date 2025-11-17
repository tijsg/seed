(() => {
  const inputEl = document.getElementById("input");
  const parseBtn = document.getElementById("parseBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const previewContainer = document.getElementById("previewContainer");
  const summaryEl = document.getElementById("summary");
  const storageKey = "seedRelationsInput";

  let lastRows = [];

  const KNOWN_HEADERS = [
    "Gemeente",
    "Verklaring van vertrek of inschrijving",
    "Land vanwaar de vreemdeling afkomstig is",
    "Naam en voornamen",
    "Naamwijziging",
    "Adres",
    "Nationaliteit",
    "Beroep",
    "Geboorteplaats",
    "Afstamming",
    "Afstamming in dalende lijn",
    "Burgerlijke staat",
    "Samenstelling van het gezin",
    "Bestaan van het identiteits- en handtekenings-certificaat",
    "Identiteitsbewijs",
    "Nummer van de Dienst Vreemdelingenzaken",
    "Bijzondere informatie (vreemdelingen)",
    "Vermelding van het register",
  ];

  const DATE_LINE_REGEX = /^(\d{2}\.\d{2}\.\d{4})\s+(.*)$/;

  function extractPersonName(text) {
    const lastNameMatch = text.match(/PEO_LastName="([^"]+)"/);
    const firstNameMatch = text.match(/PEO_FirstName="([^"]+)"/);

    if (lastNameMatch || firstNameMatch) {
      const lastName = lastNameMatch ? lastNameMatch[1].trim() : "";
      const firstName = firstNameMatch ? firstNameMatch[1].trim() : "";
      const parts = [];
      if (lastName) parts.push(lastName);
      if (firstName) parts.push(firstName);
      if (parts.length) return parts.join(", ");
    }

    const nameSectionIndex = text.indexOf("Naam en voornamen");
    if (nameSectionIndex !== -1) {
      const tail = text.slice(nameSectionIndex).split(/\r?\n/).slice(1);
      for (const line of tail) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(DATE_LINE_REGEX);
        if (m) {
          return m[2].trim();
        }
      }
    }

    return "UNKNOWN_PERSON";
  }

  function parseRelations(text) {
    const person = extractPersonName(text);
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let currentHeader = null;
    const rows = [];

    for (const line of lines) {
      if (KNOWN_HEADERS.includes(line)) {
        currentHeader = line;
        continue;
      }

      const dateMatch = line.match(DATE_LINE_REGEX);
      if (dateMatch && currentHeader) {
        const date = dateMatch[1];
        const rest = dateMatch[2].trim();
        if (!rest) continue;
        let entityValues = splitEntityValues(rest);

        if (
          currentHeader === "Afstamming in dalende lijn" &&
          entityValues[0] === "Ouder" &&
          entityValues[1] &&
          entityValues[1].toLowerCase().startsWith("van ")
        ) {
          entityValues[1] = entityValues[1].slice(4);
        }

        if (
          currentHeader === "Burgerlijke staat" &&
          entityValues[0] === "Gehuwd" &&
          entityValues[1]
        ) {
          let spouseText = entityValues[1].trim();
          if (spouseText.toLowerCase().startsWith("met ")) {
            spouseText = spouseText.slice(4).trim();
          }
          const splitTe = spouseText
            .split(/\s+te\s+/i)
            .map((chunk) => chunk.trim())
            .filter(Boolean);
          if (splitTe.length) {
            entityValues[1] = splitTe[0];
            if (splitTe.length > 1) {
              const remainder = entityValues.slice(2);
              entityValues = [
                entityValues[0],
                entityValues[1],
                ...splitTe.slice(1),
                ...remainder,
              ];
            }
          } else {
            entityValues[1] = spouseText;
          }
        }

        rows.push({
          person,
          linkType: currentHeader,
          entityValues,
          date,
        });
      }
    }

    alignSpecialColumns(rows);

    return rows;
  }

  const SPECIAL_COLUMN_MATCHERS = [
    {
      name: "gesupprimeerd",
      minTargetIndex: 3,
      matcher: (value) => /Gesupprimeerd/i.test(value),
    },
    {
      name: "rijksregisternummer",
      matcher: (value) =>
        /^\d{2}\.\d{2}\.\d{2}\s+\d{3}-\d{2}/.test(String(value).trim()),
    },
  ];

  function splitEntityValues(entityLine) {
    const trimmed = String(entityLine ?? "").trim();
    if (!trimmed) return [];

    const values = [];
    const firstChunkMatch = trimmed.match(/^[^\s(]+/);
    const firstChunk = firstChunkMatch ? firstChunkMatch[0] : "";
    if (firstChunk) {
      values.push(firstChunk);
    }

    let remainder = trimmed.slice(firstChunk.length).trim();
    const parenMatches = [...remainder.matchAll(/\(([^)]+)\)/g)].map(
      (m) => m[1]
    );
    const withoutParens = remainder.replace(/\(.*?\)/g, "").trim();
    if (withoutParens) {
      values.push(withoutParens);
    }

    values.push(...parenMatches);

    return values;
  }

  function alignSpecialColumns(rows) {
    const targetIndexByName = {};

    SPECIAL_COLUMN_MATCHERS.forEach(({ name, matcher, minTargetIndex }) => {
      let maxIndex = -1;
      rows.forEach((row) => {
        row.entityValues.forEach((value, idx) => {
          if (matcher(value)) {
            maxIndex = Math.max(maxIndex, idx);
          }
        });
      });
      if (maxIndex >= 0) {
        targetIndexByName[name] = Math.max(
          maxIndex,
          minTargetIndex ?? maxIndex
        );
      }
    });

    rows.forEach((row) => {
      SPECIAL_COLUMN_MATCHERS.forEach(({ name, matcher }) => {
        const targetIndex = targetIndexByName[name];
        if (targetIndex === undefined) return;
        const valueIndex = row.entityValues.findIndex((value) =>
          matcher(value)
        );
        if (valueIndex === -1) return;
        const [value] = row.entityValues.splice(valueIndex, 1);
        while (row.entityValues.length < targetIndex) {
          row.entityValues.push("");
        }
        row.entityValues.splice(targetIndex, 0, value);
      });
    });
  }

  function renderPreview(rows) {
    if (!rows.length) {
      previewContainer.innerHTML =
        "<i>No relations found. Check the input and parse again.</i>";
      summaryEl.textContent = "";
      downloadBtn.disabled = true;
      return;
    }

    const maxEntityCols = rows.reduce(
      (max, row) => Math.max(max, row.entityValues.length),
      0
    );
    const entityHeaders = Array.from(
      { length: maxEntityCols },
      (_, idx) => `<th>entity_value${idx}</th>`
    );

    let html =
      "<table><thead><tr>" +
      "<th>#</th>" +
      "<th>Person</th>" +
      "<th>Link type (section)</th>" +
      "<th>Date</th>" +
      entityHeaders.join("") +
      "</tr></thead><tbody>";

    rows.forEach((row, idx) => {
      html += "<tr>";
      html += `<td>${idx + 1}</td>`;
      html += `<td>${escapeHtml(row.person)}</td>`;
      html += `<td>${escapeHtml(row.linkType)}</td>`;
      html += `<td>${escapeHtml(row.date)}</td>`;

      for (let i = 0; i < maxEntityCols; i++) {
        const value = row.entityValues[i] || "";
        html += `<td>${escapeHtml(value)}</td>`;
      }

      html += "</tr>";
    });

    html += "</tbody></table>";
    previewContainer.innerHTML = html;

    summaryEl.textContent = `${rows.length} relation(s) parsed for "${rows[0].person}"`;
    downloadBtn.disabled = false;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toCSV(rows) {
    const maxEntityCols = rows.reduce(
      (max, row) => Math.max(max, row.entityValues.length),
      0
    );
    const header = [
      "person",
      "link_type",
      "date",
      ...Array.from(
        { length: maxEntityCols },
        (_, idx) => `entity_value${idx}`
      ),
    ];
    const lines = [header];

    rows.forEach((r) => {
      const rowValues = [
        r.person,
        r.linkType,
        r.date,
        ...Array.from(
          { length: maxEntityCols },
          (_, idx) => r.entityValues[idx] || ""
        ),
      ];
      lines.push(rowValues);
    });

    return lines
      .map((cols) =>
        cols
          .map((cell) => {
            const s = String(cell ?? "");
            if (/[",\n]/.test(s)) {
              return '"' + s.replace(/"/g, '""') + '"';
            }
            return s;
          })
          .join(",")
      )
      .join("\n");
  }

  function downloadCSV(csv, filename = "relations.csv") {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  parseBtn.addEventListener("click", () => {
    const text = inputEl.value || "";
    if (!text.trim()) {
      alert("Paste the document text first.");
      return;
    }
    lastRows = parseRelations(text);
    renderPreview(lastRows);
  });

  downloadBtn.addEventListener("click", () => {
    if (!lastRows.length) return;
    const csv = toCSV(lastRows);
    downloadCSV(csv);
  });

  const saveInput = () => localStorage.setItem(storageKey, inputEl.value || "");

  const savedValue = localStorage.getItem(storageKey);
  if (savedValue) {
    inputEl.value = savedValue;
  }

  inputEl.addEventListener("input", saveInput);

  inputEl.addEventListener("paste", () => {
    setTimeout(() => {
      const text = inputEl.value || "";
      saveInput();
      lastRows = parseRelations(text);
      renderPreview(lastRows);
    }, 0);
  });
})();
