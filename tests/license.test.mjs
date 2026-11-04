// scripts/license.mjs: which LICENSE files the review recognises as open
// source, by SPDX line or by the licenses' own text.
// Run with `node --test "tests/*.test.mjs"`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LICENSE_FILE, licenseOf, osiExpression } from "../scripts/license.mjs";

test("this repository's LICENSE is Apache-2.0", () => {
  assert.equal(licenseOf(readFileSync(new URL("../LICENSE", import.meta.url), "utf8")), "Apache-2.0");
});

/** The pages of terms between a GNU license's title and where it names the other GNU licenses. */
const TERMS = "Everyone is permitted to copy and distribute verbatim copies of this license document. ".repeat(10);

test("the common licenses are recognised by their text", () => {
  const cases = {
    MIT: "MIT License\n\nCopyright (c) 2026 Jane\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software...",
    ISC: "ISC License\n\nCopyright (c) 2026 Jane\n\nPermission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted, provided that...",
    "BSD-2-Clause": "Copyright (c) 2026 Jane\n\nRedistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are met:",
    "BSD-3-Clause": "Redistribution and use in source and binary forms, with or without modification...\n3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products",
    "MPL-2.0": "Mozilla Public License Version 2.0\n==================================\n\n1. Definitions",
    "GPL-3.0": `                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n\n${TERMS}use the GNU Lesser General Public License instead of this License.`,
    "GPL-2.0": `GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991\n\n${TERMS}you may consider it more useful to permit linking proprietary applications with the library.  If this is what you want to do, use the GNU Library General Public License instead`,
    "LGPL-3.0": "GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n\nThis version of the GNU Lesser General Public License incorporates the terms and conditions of version 3 of the GNU General Public License",
    "LGPL-2.1": "GNU LESSER GENERAL PUBLIC LICENSE\nVersion 2.1, February 1999",
    "AGPL-3.0": "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007",
  };
  for (const [id, text] of Object.entries(cases)) assert.equal(licenseOf(text), id, id);
});

test("an SPDX line decides, OR needs one open branch and AND needs all", () => {
  assert.equal(licenseOf("SPDX-License-Identifier: Apache-2.0\n\nCopyright 2026 Jane"), "Apache-2.0");
  assert.equal(licenseOf("/* SPDX-License-Identifier: MIT OR Apache-2.0 */"), "MIT OR Apache-2.0");
  assert.equal(licenseOf("# SPDX-License-Identifier: LicenseRef-Proprietary\nPermission is hereby granted, free of charge, to any person obtaining a copy"), null);
  assert.equal(osiExpression("(MIT OR LicenseRef-Mine)"), true);
  assert.equal(osiExpression("MIT AND LicenseRef-Mine"), false);
  assert.equal(osiExpression("GPL-2.0-only WITH Classpath-exception-2.0"), true);
  assert.equal(osiExpression("BUSL-1.1"), false);
});

test("proprietary and source-available terms are refused", () => {
  assert.equal(licenseOf("Copyright 2026 Jane. All rights reserved."), null);
  assert.equal(licenseOf("Redistribution and use in source and binary forms...\n3. All advertising materials mentioning features"), null);
  assert.equal(licenseOf('"Commons Clause" License Condition v1.0\n\nApache License, Version 2.0'), null);
  assert.equal(licenseOf("Business Source License 1.1"), null);
  assert.equal(licenseOf(""), null);
});

test("license file names", () => {
  for (const ok of ["LICENSE", "LICENSE.md", "LICENCE.txt", "COPYING", "license", "LICENSE-MIT"]) assert.ok(LICENSE_FILE.test(ok), ok);
  for (const no of ["README.md", "LICENSES/MIT.txt", "my-license"]) assert.ok(!LICENSE_FILE.test(no), no);
});
