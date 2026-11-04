// Which open-source license a LICENSE file grants, for the `license` check of
// scripts/review.mjs (docs/review.md). A Verified connector lives in its
// author's public repository under an OSI-approved license; we recommend
// Apache-2.0, this repository's own.
//
// A file is recognised by an `SPDX-License-Identifier:` line, or else by the
// distinctive text of the common licenses, unmodified.

/** License file names, in the connector's folder or at the repository's root. */
export const LICENSE_FILE = /^(licen[cs]e|copying)([.-][A-Za-z0-9.-]{1,40})?$/i;

/** OSI-approved SPDX identifiers we accept (lowercase), with the deprecated short forms people still write. */
export const OSI = new Set(
  [
    "Apache-2.0", "MIT", "MIT-0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "ISC", "MPL-2.0",
    "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later",
    "LGPL-2.0-only", "LGPL-2.0-or-later", "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later",
    "AGPL-3.0-only", "AGPL-3.0-or-later",
    "GPL-2.0", "GPL-2.0+", "GPL-3.0", "GPL-3.0+", "LGPL-2.0", "LGPL-2.0+", "LGPL-2.1", "LGPL-2.1+", "LGPL-3.0", "LGPL-3.0+", "AGPL-3.0",
    "Zlib", "BSL-1.0", "EPL-2.0", "EUPL-1.2", "Unlicense", "Artistic-2.0",
  ].map((id) => id.toLowerCase()),
); // prettier-ignore

/** The accepted licenses, as a failing check names them. */
export const ACCEPTED = "Apache-2.0 (recommended), MIT, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, or a GNU GPL, LGPL or AGPL (2.x or 3.0)";

/**
 * Whether an SPDX license expression is open source: some `OR` branch whose
 * every license (`AND`) is OSI-approved; `WITH` exceptions only add rights.
 * @param {string} expr @returns {boolean}
 */
export function osiExpression(expr) {
  const flat = expr.replace(/[()]/g, " ").trim();
  if (!flat) return false;
  return flat.split(/\s+OR\s+/i).some((branch) =>
    branch
      .split(/\s+AND\s+/i)
      .map((part) => part.split(/\s+WITH\s+/i)[0].trim().toLowerCase())
      .every((id) => OSI.has(id)),
  );
}

/**
 * Distinctive text of each common license, checked in order: a title looked
 * for near the top (the GNU licenses name each other further down; null for
 * none), then phrases anywhere.
 * @type {[string, string | null, string[]][]}
 */
const TEXTS = [
  ["AGPL-3.0", "gnu affero general public license", ["version 3, 19 november 2007"]],
  ["LGPL-3.0", "gnu lesser general public license", ["version 3, 29 june 2007"]],
  ["LGPL-2.1", "gnu lesser general public license", ["version 2.1, february 1999"]],
  ["LGPL-2.0", "gnu library general public license", ["version 2, june 1991"]],
  ["GPL-3.0", "gnu general public license", ["version 3, 29 june 2007"]],
  ["GPL-2.0", "gnu general public license", ["version 2, june 1991"]],
  ["MPL-2.0", null, ["mozilla public license version 2.0"]],
  ["MPL-2.0", null, ["mozilla public license, v. 2.0"]],
  ["Apache-2.0", null, ["apache license", "version 2.0"]],
  ["MIT", null, ["permission is hereby granted, free of charge, to any person obtaining a copy"]],
  ["ISC", null, ["permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted"]],
  ["ISC", null, ["permission to use, copy, modify, and distribute this software for any purpose with or without fee is hereby granted"]],
]; // prettier-ignore

/** Source-available terms that borrow an open-source text but take rights away. */
const RESTRICTED = /commons clause|business source license|server side public license|elastic license|polyform/;

/**
 * The license a LICENSE file grants, as an SPDX identifier or expression, or
 * null when it isn't one we recognise as open source.
 * @param {string} text @returns {string | null}
 */
export function licenseOf(text) {
  const t = text.toLowerCase().replace(/\s+/g, " ");
  if (RESTRICTED.test(t)) return null;
  const spdx = /SPDX-License-Identifier:\s*([^\n\r*]+?)\s*(?:\*\/|-->)?\s*$/im.exec(text);
  if (spdx) return osiExpression(spdx[1]) ? spdx[1] : null;
  const top = t.slice(0, 200);
  for (const [id, title, phrases] of TEXTS) {
    if ((title === null || top.includes(title)) && phrases.every((p) => t.includes(p))) return id;
  }
  // BSD: the redistribution clauses; the advertising clause (BSD-4-Clause) isn't OSI-approved.
  if (t.includes("redistribution and use in source and binary forms") && !t.includes("all advertising materials")) {
    return /neither the name|endorse or promote/.test(t) ? "BSD-3-Clause" : "BSD-2-Clause";
  }
  return null;
}
