import { getCredential } from "../server/credential-manager.js";

const token = getCredential("GITHUB_TOKEN");
if (!token) {
  console.log("NO GITHUB_TOKEN stored");
  process.exit(1);
}

// Get user info
const userRes = await fetch("https://api.github.com/user", {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
});
const user = await userRes.json();
console.log(`Username: ${user.login}`);
console.log(`Name: ${user.name}`);
console.log(`URL: ${user.html_url}`);
console.log(`Public repos: ${user.public_repos}`);
console.log(`Private repos: ${user.total_private_repos}`);
console.log("");

// List repos
const reposRes = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
});
const repos = await reposRes.json();
console.log(`Total repos returned: ${repos.length}`);
console.log("");
for (const r of repos) {
  console.log(`- ${r.name} (${r.private ? "private" : "public"}) ${r.html_url}`);
}
