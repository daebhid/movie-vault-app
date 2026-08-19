# Movie Vault — app

The public half of Movie Vault: a static web page for browsing and editing a
private film collection from a phone.

**This repo contains no film data.** No titles, no ratings, no reviews, no
posters. It is only HTML, CSS and JavaScript. It is safe for it to be public.

## How it works

There is no server and no build step. Opening the page asks for a GitHub
fine-grained token, which is stored in that browser and nowhere else. Every read
and write is a direct call to the GitHub API against your **private** data repo.
Each edit becomes a real commit.

Without a token the page is an empty shell — there is nothing to see and nothing
to guess.

```
┌──────────────┐   token in browser    ┌──────────────────┐
│  this repo   │ ────────────────────▶ │ private data repo │
│  (public)    │   GitHub REST API     │  movies/ posters/ │
│  page only   │ ◀──────────────────── │  index.json       │
└──────────────┘                       └──────────────────┘
```

## Files

| File | Purpose |
|---|---|
| `index.html` | The page shell |
| `style.css` | Phone-first styling |
| `frontmatter.js` | Surgical markdown editing — the safety-critical part |
| `app.js` | Everything else: API, gallery, filters, editors |
| `test-frontmatter.js` | Runs the editors over every real film |

## Films and series

A record's `category:` is `film` or `tv`. A film owns a `copies:` block; a
series owns `seasons:` instead, one entry per season with its own format and
shelf location. Both blocks have the same shape, so the same nested-block
editor drives them — `getCopies` and `setCopyField` take the block name, and
the detail sheet only swaps the heading and the row label.

## Editing rule

`frontmatter.js` never parses YAML into an object and writes it back out. Doing
so would reorder keys, restyle lists and reflow the folded `plot:` blocks, so a
one-tap rating change would rewrite the whole file and mangle anything
hand-edited in Typora. Instead it replaces only the exact lines it targets.

Any change to that file must keep the test passing:

```sh
node test-frontmatter.js ../movie-vault-data
```

It checks every film and fails if an edit disturbs a single untargeted byte.

## Running it locally

Needs to be served over http — `file://` disables the poster cache.

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

## Publishing

Settings → Pages → Deploy from branch → `main` / root.
