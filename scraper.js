// Import required modules
const fs = require('fs');
const readline = require('readline');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// Main scraping function
async function scrapeTikTok(username) {
  const url = `https://www.tiktok.com/@${username}`;
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  await page.goto(url, { waitUntil: 'networkidle2' });
  console.log(`🔍 Scraping profile: ${url}`);

  await page.waitForSelector('h1[data-e2e="user-title"]');

  const profile = await page.evaluate(() => {
    const getText = (selector) => {
      const el = document.querySelector(selector);
      return el ? el.textContent.trim() : null;
    };

    return {
      username: getText('h1[data-e2e="user-title"]'),
      displayName: getText('h2[data-e2e="user-subtitle"]'),
      bio: getText('h2[data-e2e="user-bio"]'),
      followers: getText('strong[data-e2e="followers-count"]'),
      following: getText('strong[data-e2e="following-count"]'),
      likes: getText('strong[data-e2e="likes-count"]')
    };
  });

  console.log('✅ Profile scraped:\n', profile);

  try {
    await page.waitForSelector('button.TUXSegmentedControl-item', { timeout: 7000 });
    const tabButtons = await page.$$('button.TUXSegmentedControl-item');
    let popularButton = null;
    for (const btn of tabButtons) {
      const text = await btn.evaluate(el => el.textContent.trim());
      if (text === 'Popular') {
        popularButton = btn;
        break;
      }
    }
    if (!popularButton) throw new Error('Popular tab button not found');
    const isActive = await popularButton.evaluate(el => el.getAttribute('data-active') === 'true');
    if (!isActive) {
      await popularButton.click();
      console.log('➡️ Switched to "Popular" tab, waiting for videos to load...');
      await delay(3000);
    } else {
      console.log('ℹ️ Already on "Popular" tab');
    }
  } catch (e) {
    console.warn(`⚠️ Failed to switch to "Popular" tab: ${e.message}`);
  }

  await autoScroll(page);

  const popularVideos = await page.$$eval('div[data-e2e="user-post-item"] a', links => {
    return links.map(a => {
      const container = a.closest('div[data-e2e="user-post-item"]');
      const viewEl = container?.querySelector('strong[data-e2e="video-views"]');
      return {
        url: a.href,
        views: viewEl ? viewEl.textContent.trim() : '0'
      };
    }).filter(v => v.url.includes('/video/'));
  });

  console.log(`📦 Total videos available in Popular tab: ${popularVideos.length}`);

  const limit = await askVideoLimit(popularVideos.length);
  const videos = [];
  const videoPage = await browser.newPage();

  for (let i = 0; i < limit; i++) {
    const videoUrl = popularVideos[i].url;
    const extractedViews = popularVideos[i].views;

    try {
      console.log(`🎥 Scraping video ${i + 1}/${limit}: ${videoUrl}`);
      await videoPage.goto(videoUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      await videoPage.waitForSelector('[data-e2e="like-count"], span[data-e2e="like-count"]', { timeout: 20000 });

      const videoData = await videoPage.evaluate(() => {
        const getTextByAttr = (attrVal) => {
          const el = document.querySelector(`[data-e2e="${attrVal}"]`);
          return el ? el.textContent.trim() : '0';
        };

        const getTextByFallback = (query) => {
          const el = document.querySelector(query);
          return el ? el.textContent.trim() : '0';
        };

        return {
          likes: getTextByAttr('like-count') || getTextByFallback('span[data-e2e="like-count"]'),
          comments: getTextByAttr('comment-count') || getTextByFallback('span[data-e2e="comment-count"]'),
          shares: getTextByAttr('share-count') || getTextByFallback('span[data-e2e="share-count"]'),
        };
      });

      videos.push({
        videoLink: videoUrl,
        likes: videoData.likes,
        comments: videoData.comments,
        shares: videoData.shares,
        views: extractedViews
      });

      console.log(`✅ Scraped: ${videoData.likes} 👍 | ${videoData.comments} 💬 | ${videoData.shares} 🔁 | ${extractedViews} 👀`);
      await delay(2000);
    } catch (err) {
      console.log(`⚠️ Failed to scrape video stats for ${videoUrl}:`, err.message);
    }
  }

  await videoPage.close();
  await browser.close();

  const result = { profile, totalPopularVideos: popularVideos.length, videos };
  fs.writeFileSync(`tiktok_${username}_popular.json`, JSON.stringify(result, null, 2));
  console.log(`📁 Results saved to tiktok_${username}_popular.json`);
  return result;
}

// Prompt user to input how many videos to fetch
async function askVideoLimit(max) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (str) => new Promise(resolve => rl.question(str, resolve));

  let limit;
  while (true) {
    const answer = await question(`🔢 Enter number of videos to scrape (max ${max}): `);
    limit = parseInt(answer);
    if (!isNaN(limit) && limit > 0 && limit <= max) break;
    console.log(`❌ Invalid input. Please enter a number between 1 and ${max}`);
  }

  rl.close();
  return limit;
}

// Ask user for TikTok username
async function askUsername() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (str) => new Promise(resolve => rl.question(str, resolve));
  const username = await question('👤 Enter TikTok username (without @): ');
  rl.close();
  return username.trim();
}

// Cleaned dynamic auto-scroll function
async function autoScroll(page, maxScrolls = 50, pauseTime = 1000) {
  let lastVideoCount = 0;
  let unchangedScrolls = 0;

  for (let i = 0; i < maxScrolls; i++) {
    const currentCount = await page.$$eval('div[data-e2e="user-post-item"]', els => els.length);

    if (currentCount === lastVideoCount) {
      unchangedScrolls++;
    } else {
      unchangedScrolls = 0;
    }

    if (unchangedScrolls >= 3) {
      console.log('🛑 No new videos loaded after multiple scrolls. Stopping scroll...');
      break;
    }

    lastVideoCount = currentCount;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await delay(pauseTime);
  }

  console.log(`✅ Finished scrolling. Total videos loaded: ${lastVideoCount}`);
}

// Delay helper
function delay(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

// Script entry point
(async () => {
  try {
    const username = await askUsername();
    const result = await scrapeTikTok(username);
    console.log('\n🎉 Scraping complete!');
    console.log('Profile info:', result.profile);
    console.log(`Total Popular Videos: ${result.totalPopularVideos}`);
    console.log('Top videos scraped:', result.videos.length);
  } catch (error) {
    console.error('❌ Scrape failed:', error);
  }
})();
