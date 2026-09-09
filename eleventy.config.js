import { feedPlugin } from "@11ty/eleventy-plugin-rss";
import site from "./src/_data/site.json" with { type: "json" };

export default function (eleventyConfig) {
  // Files with `draft: true` in their front matter are skipped in production
  // builds but still rendered by `eleventy --serve` so they can be previewed.
  eleventyConfig.addPreprocessor("drafts", "*", (data) => {
    if (data.draft && process.env.ELEVENTY_RUN_MODE === "build") {
      return false;
    }
  });

  // Static assets are copied to the output as-is.
  eleventyConfig.addPassthroughCopy("src/css");
  eleventyConfig.addPassthroughCopy("src/images");

  // RSS feed of the latest posts at /feed.xml.
  eleventyConfig.addPlugin(feedPlugin, {
    type: "rss",
    outputPath: "/feed.xml",
    collection: { name: "posts", limit: 10 },
    metadata: {
      language: "en",
      title: site.title,
      subtitle: site.description,
      base: site.url,
      author: { name: site.author.name, email: site.author.email },
    },
  });

  // Every tag used on a post, with its post count, alphabetically.
  eleventyConfig.addCollection("tagList", (api) => {
    const counts = new Map();
    for (const post of api.getFilteredByTag("posts")) {
      for (const tag of post.data.tags ?? []) {
        if (tag === "posts") continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  // Posts grouped by year, newest year and newest post first.
  eleventyConfig.addCollection("postsByYear", (api) => {
    const groups = new Map();
    for (const post of api.getFilteredByTag("posts").reverse()) {
      const year = post.date.getUTCFullYear();
      if (!groups.has(year)) groups.set(year, []);
      groups.get(year).push(post);
    }
    return [...groups].map(([year, posts]) => ({ year, posts }));
  });

  // A post's own tags, without the internal "posts" collection tag.
  eleventyConfig.addFilter("postTags", (tags) => (tags ?? []).filter((t) => t !== "posts"));

  // Dates from filenames are parsed as UTC, so format them in UTC too.
  const utc = (locale, options) => new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });

  // "27 Jul 2015". Assembled from parts so every month is three letters
  // (the en-GB locale would give "Sept").
  eleventyConfig.addFilter("postDate", (date) => {
    const parts = utc("en-US", { day: "numeric", month: "short", year: "numeric" }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get("day")} ${get("month")} ${get("year")}`;
  });

  // "Jul 27"
  eleventyConfig.addFilter("archiveDate", (date) =>
    utc("en-US", { month: "short", day: "numeric" }).format(date)
  );

  // "2015-07-27", for <time datetime="">
  eleventyConfig.addFilter("isoDate", (date) => date.toISOString().slice(0, 10));

  // Rough reading time from rendered HTML, at 200 words per minute.
  eleventyConfig.addFilter("readingTime", (html) => {
    const words = String(html ?? "").replace(/<[^>]+>/g, " ").trim().split(/\s+/).filter(Boolean).length;
    return `${Math.max(1, Math.ceil(words / 200))} min read`;
  });

  return {
    dir: {
      input: "src",
      output: "_site",
    },
  };
}
