import assert from "node:assert/strict";

export function changelogNotes(changelog: string, version: string): string {
	const section = changelog
		.split(/^## /m)
		.slice(1)
		.find((entry) => entry.split(/\s/, 1)[0] === version);
	assert.ok(section, `Missing changelog entry for ${version}`);
	const notes = section.slice(section.indexOf("\n") + 1).trim();
	assert.ok(notes && section.includes("\n"), `Empty changelog entry for ${version}`);
	assert.ok(Buffer.byteLength(notes) <= 8_000, `Changelog entry for ${version} exceeds 8 KB`);
	return notes;
}
