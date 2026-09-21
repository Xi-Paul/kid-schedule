/* github.js — GitHub 저장소를 데이터 저장소로 쓰는 계층.
 *
 * 쓰기는 Contents API(PUT)를 씁니다. 이 API는 대상 파일의 blob sha를 요구하고,
 * sha가 최신이 아니면 409를 돌려줍니다. 그래서 모든 쓰기는
 * 읽기 → 수정 → 쓰기(sha 동봉) 이고, 409면 다시 읽어 재시도합니다.
 *
 * api.github.com 은 Access-Control-Allow-Origin: * 를 보내므로 브라우저에서 바로 호출됩니다.
 * 토큰은 이 파일에 절대 넣지 마세요. 사용자가 기기에서 입력한 값을 넘겨받습니다.
 */
(function (global) {
  "use strict";

  const API = "https://api.github.com";

  /* ---- UTF-8 안전 base64 (한글 때문에 btoa 직접 호출은 깨집니다) ---- */
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(String(b64).replace(/\s/g, ""));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  class GhError extends Error {
    constructor(status, message, body) {
      super(message);
      this.name = "GhError";
      this.status = status;
      this.body = body;
    }
  }

  /** 상태 코드를 사용자가 읽을 수 있는 문장으로 */
  function explain(status, body) {
    const msg = (body && body.message) || "";
    switch (status) {
      case 401: return "토큰이 올바르지 않거나 만료됐습니다. 설정에서 다시 발급해 넣어 주세요.";
      case 403:
        if (/rate limit/i.test(msg)) return "GitHub 요청 한도를 넘었습니다. 잠시 뒤 다시 시도하세요.";
        return "토큰에 이 저장소 쓰기 권한이 없습니다. Contents를 Read and write로 주세요.";
      case 404: return "저장소나 경로를 찾지 못했습니다. 소유자·저장소 이름과 토큰 접근 범위를 확인하세요.";
      case 409: return "다른 기기가 먼저 저장했습니다. 다시 불러와 합칩니다.";
      case 422: return "GitHub가 요청 내용을 거부했습니다: " + msg;
      default:  return `GitHub 오류 ${status}${msg ? " — " + msg : ""}`;
    }
  }

  class Repo {
    /** @param {{owner:string, repo:string, branch:string, token?:string}} o */
    constructor(o) {
      this.owner = o.owner;
      this.repo = o.repo;
      this.branch = o.branch || "main";
      this.token = o.token || "";
      this.rate = { remaining: null, reset: null };
      this.slug = `${this.owner}/${this.repo}`;
    }

    get authed() { return !!this.token; }

    _headers(extra) {
      const h = Object.assign({
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }, extra || {});
      if (this.token) h["Authorization"] = "Bearer " + this.token;
      return h;
    }

    _trackRate(res) {
      const rem = res.headers.get("x-ratelimit-remaining");
      const rst = res.headers.get("x-ratelimit-reset");
      if (rem !== null) this.rate.remaining = Number(rem);
      if (rst !== null) this.rate.reset = Number(rst) * 1000;
    }

    /** 토큰·저장소 접근 확인. 성공하면 권한 정보를 돌려줍니다. */
    async check() {
      const res = await fetch(`${API}/repos/${this.slug}`, { headers: this._headers() });
      this._trackRate(res);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new GhError(res.status, explain(res.status, body), body);
      return {
        fullName: body.full_name,
        private: body.private,
        canPush: !!(body.permissions && body.permissions.push),
        defaultBranch: body.default_branch
      };
    }

    /**
     * 파일을 JSON으로 읽습니다.
     * @returns {{data:any|null, sha:string|null, missing:boolean}}
     */
    async readJson(path) {
      const url = `${API}/repos/${this.slug}/contents/${encodeURI(path)}`
        + `?ref=${encodeURIComponent(this.branch)}&t=${Date.now()}`;
      const res = await fetch(url, { headers: this._headers({ "Cache-Control": "no-cache" }) });
      this._trackRate(res);
      if (res.status === 404) return { data: null, sha: null, missing: true };
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new GhError(res.status, explain(res.status, body), body);
      if (Array.isArray(body)) throw new GhError(422, `${path} 은 파일이 아니라 폴더입니다.`, body);

      let text;
      if (body.content) text = b64decode(body.content);
      else if (body.download_url) text = await (await fetch(body.download_url)).text();
      else throw new GhError(422, `${path} 내용을 읽지 못했습니다. 파일이 너무 큽니다.`, body);

      let data;
      try { data = JSON.parse(text); }
      catch (e) { throw new GhError(422, `${path} 이 올바른 JSON이 아닙니다.`, null); }
      return { data, sha: body.sha, missing: false };
    }

    /** 토큰 없이 읽기 — raw.githubusercontent.com (약 5분 캐시, 공개 저장소만) */
    async readJsonPublic(path) {
      const url = `https://raw.githubusercontent.com/${this.slug}/${this.branch}/${encodeURI(path)}?t=${Date.now()}`;
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 404) return { data: null, sha: null, missing: true };
      if (!res.ok) throw new GhError(res.status, `파일을 받지 못했습니다 (${res.status}).`, null);
      return { data: await res.json(), sha: null, missing: false };
    }

    /**
     * JSON 파일 하나를 통째로 씁니다. sha 를 넘기면 그 버전 위에만 씁니다.
     * @returns {{sha:string, commit:string}}
     */
    async writeJson(path, data, sha, message) {
      if (!this.token) throw new GhError(401, "쓰기에는 토큰이 필요합니다.", null);
      const payload = {
        message: message || `chore: ${path} 갱신`,
        content: b64encode(JSON.stringify(data, null, 2) + "\n"),
        branch: this.branch
      };
      if (sha) payload.sha = sha;

      const res = await fetch(`${API}/repos/${this.slug}/contents/${encodeURI(path)}`, {
        method: "PUT",
        headers: this._headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload)
      });
      this._trackRate(res);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new GhError(res.status, explain(res.status, body), body);
      return { sha: body.content.sha, commit: body.commit.sha };
    }

    /**
     * 읽기 → 수정 → 쓰기. sha 충돌(409/422)이면 다시 읽어 최대 4회 재시도합니다.
     * @param {string} path
     * @param {(current:any|null)=>any} mutate  현재 내용을 받아 새 내용을 반환
     * @param {string} message 커밋 메시지
     */
    async updateJson(path, mutate, message) {
      let lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        const cur = await this.readJson(path);
        const next = mutate(cur.data);
        if (next === null || next === undefined) return { skipped: true };
        try {
          const r = await this.writeJson(path, next, cur.sha, message);
          return { sha: r.sha, commit: r.commit, data: next, attempts: attempt + 1 };
        } catch (e) {
          // 409 = sha 불일치, 422 = 같은 원인으로 오는 경우가 있음
          if (e.status === 409 || e.status === 422) {
            lastErr = e;
            await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
            continue;
          }
          throw e;
        }
      }
      throw lastErr || new GhError(409, "여러 번 시도했지만 저장하지 못했습니다.", null);
    }
  }

  global.GH = { Repo, GhError, b64encode, b64decode, explain };
})(typeof window !== "undefined" ? window : globalThis);
