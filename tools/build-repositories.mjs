/*
 * Regenerates the repository dependency data embedded in repositories.html.
 *
 *   node tools/build-repositories.mjs
 *
 * Requires the GitHub CLI, authenticated (`gh auth status`), because it reads
 * every csproj in every public repo.
 *
 * Why csproj and not the published NuGet manifests: this page answers "what
 * order do I update my repos in", and that has to include dependencies that
 * exist in source but are not published — sample projects, test projects, and
 * repos that ship no package at all (Starter, Depend, Logging are invisible to
 * the package graph). The package page deliberately uses the manifests instead,
 * because it describes what consumers actually resolve.
 *
 * Only structure is written out. Descriptions, last-push dates and issue counts
 * are fetched live by the page from the GitHub API.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(ROOT, "repositories.html");
const ORG = "Tharga";

const gh = (p) => JSON.parse(execFileSync("gh", ["api", p], { encoding: "utf8", maxBuffer: 64 << 20 }));
const raw = (p) => execFileSync("gh", ["api", p, "-H", "Accept: application/vnd.github.raw"], { encoding: "utf8", maxBuffer: 64 << 20 });

const REPO_ALIAS = { "tharga-console": "Console" };

/* Which repo builds which package, taken from the published manifests rather
 * than guessed from the csproj files — a repo's sample projects are named like
 * packages but are not published, and Tharga.Test.Toolkit lives in a path that
 * any "is this a test project" heuristic would misread. */
async function packageOwners() {
	const search = "https://azuresearch-usnc.nuget.org/query?q=Tharga&take=200&prerelease=true&semVerLevel=2.0.0";
	const res = await fetch(search);
	if (!res.ok) throw new Error(`nuget search failed: ${res.status}`);
	const { data } = await res.json();

	const owners = {};
	for (const p of data.filter((p) => p.id.toLowerCase().startsWith("tharga"))) {
		const low = p.id.toLowerCase();
		const r = await fetch(`https://api.nuget.org/v3-flatcontainer/${low}/${p.version.toLowerCase()}/${low}.nuspec`);
		if (!r.ok) continue;
		const url = ((await r.text()).match(/<repository[^>]*url="([^"]+)"/) || [])[1] || "";
		if (!url) continue;
		const last = url.replace(/\.git$/, "").split("/").filter(Boolean).pop() || "";
		owners[p.id] = REPO_ALIAS[last.toLowerCase()] || last;
	}
	return owners;
}

/* A project is a test project when it pulls in the test SDK, or is named for
 * one. Path-contains-"test" is wrong: it catches Tharga.Test.Toolkit itself. */
const isTestProject = (xml, path) =>
	/<PackageReference\s+Include="(Microsoft\.NET\.Test\.Sdk|xunit|NUnit|MSTest)/i.test(xml) ||
	/\.Tests?\.csproj$/i.test(path);

async function main() {
	const repos = gh(`orgs/${ORG}/repos?per_page=100`)
		.filter((r) => !r.private && !r.archived && !r.fork)
		.map((r) => ({ name: r.name, branch: r.default_branch }))
		.sort((a, b) => a.name.localeCompare(b.name));

	if (!repos.length) throw new Error("no public repos returned — refusing to write an empty page");
	console.log(`scanning ${repos.length} public repos\n`);

	const names = new Set(repos.map((r) => r.name));
	const owns = await packageOwners();
	console.log(`${Object.keys(owns).length} published packages mapped to repos\n`);

	const found = {};  // repo -> { main:Set, test:Set, pkgs:Set }

	for (const r of repos) {
		found[r.name] = { main: new Set(), test: new Set(), pkgs: new Set() };
		Object.keys(owns).forEach((pkg) => { if (owns[pkg] === r.name) found[r.name].pkgs.add(pkg); });

		let tree;
		try {
			tree = gh(`repos/${ORG}/${r.name}/git/trees/${r.branch}?recursive=1`);
		} catch {
			console.log(`${r.name}: could not read tree, skipped`);
			continue;
		}
		const files = (tree.tree || []).filter((n) => n.type === "blob" && n.path.endsWith(".csproj"));
		for (const f of files) {
			let xml;
			try { xml = raw(`repos/${ORG}/${r.name}/contents/${encodeURI(f.path)}?ref=${r.branch}`); } catch { continue; }
			const bucket = isTestProject(xml, f.path) ? "test" : "main";
			for (const m of xml.matchAll(/<PackageReference\s+Include="(Tharga\.[^"]+)"/g)) {
				found[r.name][bucket].add(m[1]);
			}
		}
		console.log(`${r.name}: ${files.length} csproj, ${found[r.name].pkgs.size} packages`);
	}

	// resolve package references to the repo that builds them
	const out = {}, unresolved = new Set();
	for (const r of repos) {
		const map = (set) => {
			const to = new Set();
			for (const pkg of set) {
				const target = owns[pkg];
				if (!target) { unresolved.add(pkg); continue; }
				if (target !== r.name && names.has(target)) to.add(target);
			}
			return [...to].sort();
		};
		const main = map(found[r.name].main);
		const test = map(found[r.name].test).filter((t) => !main.includes(t));
		out[r.name] = { dep: main, test, pkgs: [...found[r.name].pkgs].sort() };
	}

	const body = Object.keys(out).sort()
		.map((n) => `\t\t\t\t${JSON.stringify(n)}:${JSON.stringify(out[n])}`)
		.join(",\n");

	const block =
		"/* REPOS:start — generated by tools/build-repositories.mjs, do not edit by hand */\n" +
		"\t\t\tvar REPOS = {\n" + body + "\n\t\t\t};\n" +
		"\t\t\t/* REPOS:end */";

	let html = readFileSync(PAGE, "utf8");
	const marker = /\/\* REPOS:start[\s\S]*?\/\* REPOS:end \*\//;
	if (!marker.test(html)) throw new Error("REPOS markers not found in repositories.html");

	const today = new Date().toISOString().slice(0, 10);
	html = html.replace(marker, block).replace(/csproj files on \d{4}-\d{2}-\d{2}/, `csproj files on ${today}`);
	writeFileSync(PAGE, html);

	const edges = Object.values(out).reduce((s, r) => s + r.dep.length, 0);
	const testEdges = Object.values(out).reduce((s, r) => s + r.test.length, 0);
	console.log(`\nwrote ${repos.length} repos, ${edges} dependencies (+${testEdges} test-only) to repositories.html (${today})`);
	if (unresolved.size) console.log(`\nreferenced but built by no scanned repo: ${[...unresolved].sort().join(", ")}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
