export default {
  async fetch(request, env, ctx) {
    // CORS Header Definitions
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    // KV Namespace binding is named 'SCORES'
    const KV = env.SCORES;

    if (!KV) {
      return new Response(JSON.stringify({ error: "KV 'SCORES' is not configured." }), { 
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders } 
      });
    }

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === "GET") {
      try {
        const url = new URL(request.url);
        const mode = url.searchParams.get("mode");
        const data = await KV.get("LEADERBOARD");
        let leaderboard = data ? JSON.parse(data) : [];

        // --- アベレージランキングモード ---
        if (mode === "average") {
          const statsData = await KV.get("PLAYER_STATS");
          const stats = statsData ? JSON.parse(statsData) : {};

          const avgRanking = Object.values(stats)
            .filter(p => p.count >= 1)
            .map(p => ({
              name:  p.name,
              avg:   Math.round((p.total / p.count) * 10) / 10,
              best:  p.best,
              games: p.count,
              city:  (p.city && p.city !== "Unknown") ? p.city : null
            }))
            .sort((a, b) => {
              if (b.avg !== a.avg) return b.avg - a.avg;
              return b.games - a.games;
            })
            .slice(0, 50);

          return new Response(JSON.stringify(avgRanking), {
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // --- 地域別ランキングモード ---
        if (mode === "regional") {
          const cityMap = new Map();
          for (const entry of leaderboard) {
            const city = (entry.location?.city && entry.location.city !== "Unknown")
              ? entry.location.city : null;
            if (!city) continue;

            if (!cityMap.has(city)) {
              cityMap.set(city, { city, total: 0, count: 0, best: 0, country: entry.location?.country || "" });
            }
            const rec = cityMap.get(city);
            rec.total += entry.score;
            rec.count += 1;
            if (entry.score > rec.best) rec.best = entry.score;
          }

          const regional = Array.from(cityMap.values())
            .map(r => ({
              city:    r.city,
              country: r.country,
              avg:     Math.round((r.total / r.count) * 10) / 10,
              count:   r.count,
              best:    r.best
            }))
            .sort((a, b) => {
              if (b.avg !== a.avg) return b.avg - a.avg;
              return b.count - a.count;
            })
            .slice(0, 50);

          return new Response(JSON.stringify(regional), {
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // --- 個人ランキングモード（デフォルト）---
        leaderboard = leaderboard.map(entry => {
          const { location, playerId, ...rest } = entry;
          return {
            ...rest,
            city: (location?.city && location.city !== "Unknown") ? location.city : null
          };
        });

        return new Response(JSON.stringify(leaderboard), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Failed to fetch scores." }), { 
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    if (request.method === "POST") {
      try {
        const body = await request.json();
        if (!body.name || typeof body.score !== "number") {
          return new Response(JSON.stringify({ error: "Invalid data." }), { 
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders } 
          });
        }

        // Cloudflare IP ベース位置情報
        const location = {
          country: request.cf?.country || "Unknown",
          region:  request.cf?.region  || "Unknown",
          city:    request.cf?.city    || "Unknown"
        };

        const name     = String(body.name).substring(0, 12) || "Anonymous";
        const score    = Math.min(300, Math.max(0, body.score));
        const date     = body.date || new Date().toISOString();
        const playerId = body.playerId ? String(body.playerId).substring(0, 64) : null;

        // --- PLAYER_STATS を更新（累積アベレージ用）---
        if (playerId) {
          const statsData = await KV.get("PLAYER_STATS");
          const stats = statsData ? JSON.parse(statsData) : {};

          const prev = stats[playerId] || { total: 0, count: 0, best: 0 };
          stats[playerId] = {
            name:     name,
            total:    prev.total + score,
            count:    prev.count + 1,
            best:     Math.max(prev.best, score),
            city:     location.city,
            lastDate: date
          };

          const allStats = Object.entries(stats);
          if (allStats.length > 10000) {
            allStats.sort((a, b) => (b[1].best - a[1].best));
            const trimmed = Object.fromEntries(allStats.slice(0, 10000));
            await KV.put("PLAYER_STATS", JSON.stringify(trimmed));
          } else {
            await KV.put("PLAYER_STATS", JSON.stringify(stats));
          }
        }

        // --- LEADERBOARD を更新（ベストスコア個人ランキング用）---
        const lbData = await KV.get("LEADERBOARD");
        let leaderboard = lbData ? JSON.parse(lbData) : [];

        const newEntry = { name, score, date, location, playerId };

        if (playerId) {
          // 同一playerId かつ 同一名前の場合にベストスコア更新
          const existingIdx = leaderboard.findIndex(e => e.playerId === playerId && e.name === name);
          if (existingIdx !== -1) {
            if (score > leaderboard[existingIdx].score) {
              leaderboard[existingIdx] = newEntry;
            }
          } else {
            leaderboard.push(newEntry);
          }
        } else {
          leaderboard.push(newEntry);
        }

        leaderboard.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return new Date(a.date) - new Date(b.date);
        });

        leaderboard = leaderboard.slice(0, 100);
        await KV.put("LEADERBOARD", JSON.stringify(leaderboard));

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Failed to save score." }), { 
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }
};