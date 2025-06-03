import json
import asyncio
from playwright.async_api import async_playwright


async def delay(seconds):
    await asyncio.sleep(seconds)


async def ask_username():
    return input("👤 Enter TikTok username (without @): ").strip()


def ask_video_limit(max_limit):
    while True:
        try:
            val = int(input(f"🔢 Enter number of videos to scrape (max {max_limit}): "))
            if 1 <= val <= max_limit:
                return val
        except ValueError:
            pass
        print(f"❌ Invalid input. Please enter a number between 1 and {max_limit}")


async def auto_scroll(page, max_scrolls=50, pause_time=1.0):
    last_video_count = 0
    unchanged_scrolls = 0

    for _ in range(max_scrolls):
        current_count = await page.locator('div[data-e2e="user-post-item"]').count()
        if current_count == last_video_count:
            unchanged_scrolls += 1
        else:
            unchanged_scrolls = 0
        if unchanged_scrolls >= 3:
            print("🛑 No new videos loaded. Stopping scroll.")
            break
        last_video_count = current_count
        await page.evaluate("window.scrollBy(0, window.innerHeight);")
        await delay(pause_time)
    print(f"✅ Finished scrolling. Total videos loaded: {last_video_count}")


async def scrape_tiktok(username):
    url = f"https://www.tiktok.com/@{username}"

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, args=["--no-sandbox"])
        page = await browser.new_page()
        await page.goto(url, wait_until='networkidle')
        print(f"🔍 Scraping profile: {url}")

        await page.wait_for_selector('h1[data-e2e="user-title"]', timeout=15000)

        profile = {
            "username": await page.locator('h1[data-e2e="user-title"]').inner_text(),
            "displayName": await page.locator('h2[data-e2e="user-subtitle"]').inner_text(),
            "bio": await page.locator('h2[data-e2e="user-bio"]').inner_text(),
            "followers": await page.locator('strong[data-e2e="followers-count"]').inner_text(),
            "following": await page.locator('strong[data-e2e="following-count"]').inner_text(),
            "likes": await page.locator('strong[data-e2e="likes-count"]').inner_text()
        }
        print("✅ Profile scraped:\n", profile)

        # Attempt to switch to "Popular" tab
        try:
            await page.wait_for_selector('button.TUXSegmentedControl-item', timeout=7000)
            buttons = page.locator('button.TUXSegmentedControl-item')
            for i in range(await buttons.count()):
                text = await buttons.nth(i).inner_text()
                if text.strip().lower() == "popular":
                    is_active = await buttons.nth(i).get_attribute("data-active")
                    if is_active != "true":
                        await buttons.nth(i).click()
                        print("➡️ Switched to 'Popular' tab.")
                        await delay(3)
                    else:
                        print("ℹ️ Already on 'Popular' tab.")
                    break
        except Exception as e:
            print(f"⚠️ Could not switch to 'Popular' tab: {e}")

        await auto_scroll(page)

        anchors = page.locator('div[data-e2e="user-post-item"] a')
        video_count = await anchors.count()
        popular_videos = []

        for i in range(video_count):
            href = await anchors.nth(i).get_attribute('href')
            view_el = await anchors.nth(i).locator('xpath=../../..//strong[data-e2e="video-views"]').element_handle()
            views = await view_el.inner_text() if view_el else "0"
            if "/video/" in href:
                popular_videos.append({ "url": f"https://www.tiktok.com{href}", "views": views })

        print(f"📦 Found {len(popular_videos)} videos in 'Popular' tab.")
        limit = ask_video_limit(len(popular_videos))

        videos = []
        video_page = await browser.new_page()

        for i in range(limit):
            video = popular_videos[i]
            print(f"🎥 Scraping video {i + 1}/{limit}: {video['url']}")
            try:
                await video_page.goto(video["url"], wait_until='networkidle')
                await video_page.wait_for_selector('[data-e2e="like-count"]', timeout=15000)

                likes = await video_page.locator('[data-e2e="like-count"]').inner_text()
                comments = await video_page.locator('[data-e2e="comment-count"]').inner_text()
                shares = await video_page.locator('[data-e2e="share-count"]').inner_text()

                videos.append({
                    "videoLink": video["url"],
                    "likes": likes,
                    "comments": comments,
                    "shares": shares,
                    "views": video["views"]
                })
                print(f"✅ Scraped: {likes} 👍 | {comments} 💬 | {shares} 🔁 | {video['views']} 👀")
                await delay(2)
            except Exception as e:
                print(f"⚠️ Failed to scrape {video['url']}: {e}")

        await video_page.close()
        await browser.close()

        result = {
            "profile": profile,
            "totalPopularVideos": len(popular_videos),
            "videos": videos
        }

        filename = f"tiktok_{username}_popular.json"
        with open(filename, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)

        print(f"📁 Results saved to {filename}")
        return result


if __name__ == "__main__":
    try:
        username = asyncio.run(ask_username())
        result = asyncio.run(scrape_tiktok(username))
        print("\n🎉 Scraping complete!")
        print("Profile info:", result["profile"])
        print(f"Total Popular Videos: {result['totalPopularVideos']}")
        print(f"Top videos scraped: {len(result['videos'])}")
    except Exception as e:
        print("❌ Scrape failed:", e)
