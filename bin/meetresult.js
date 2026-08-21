#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// --disable-warning=ExperimentalWarning: menekan warning bawaan Node soal `localStorage` yang
// dipicu oleh dependency `docx` menyentuh globalThis.localStorage saat di-load - tidak relevan
// sama sekali dengan MeetResult, cuma bikin log/output berisik.
require("../src/cli.js");
