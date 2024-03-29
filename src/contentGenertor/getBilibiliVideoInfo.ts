import { browser } from '../utils/initBrowser';
import bilibiliCookie from '../bilibiliCookie.json';
import { generateSrtSubtitle } from '../utils/srtSubtitle';
import { blobServiceClient } from '../utils/azureStorage';
import fs from 'fs/promises';
import srtToAss from 'srt-to-ass';
import path from 'path';
import logger from '../utils/logger'
import { getRandom, sleep, exists, trimSpecial, retryRace } from '../utils/utils';


const containerName = 'subtitle2';


export async function getBilibiliVideoInfo(
  specialName: string,
  comedianName: string,
) {
  const bilibiliPage = await browser.newPage();

  bilibiliPage.setCookie(...bilibiliCookie);
  try {

    await bilibiliPage.goto('https://search.bilibili.com/', {
      timeout: 60 * 1000,
    });

    // await bilibiliPage.waitForTimeout(getRandom(10) * 1000)

    await bilibiliPage.waitForSelector('.search-input-el');

    await bilibiliPage.type('.search-input-el', `${specialName} ${comedianName}`);

    await bilibiliPage.evaluate(() => {
      const button = document.querySelector('.search-button');
      button && (button as HTMLAnchorElement).click();
    });

    const hasVideo = await (async () => {
      try {
        const has = await bilibiliPage.waitForSelector('.video-list div a[href]', {
          timeout: 5000,
        })          
        return Boolean(has)
      } catch (error) {
        return false
      }
    })()

    console.log('hasVideo', Boolean(hasVideo))

    if (hasVideo) {
      const videoUrl = await bilibiliPage.evaluate(() => {
        const element = document.querySelector('.video-list div a[href]');
        return (element as HTMLAnchorElement)?.href;
      });
  
      if (videoUrl) {
        await bilibiliPage.goto(videoUrl, {
          timeout: 60 * 1000,
        });
  
        await bilibiliPage.waitForSelector('#share-btn-iframe');
  
        const videoInfo = await bilibiliPage.evaluate(async () => {
          const state = window.__INITIAL_STATE__;
          const { cidMap } = state;
          const keys = Object.keys(cidMap);
          const key = keys[0];
          const vInfo = cidMap[key];
          const { aid, bvid } = vInfo;
          const cid = key;
          let subtitles: Array<{
            // "en-US"
            lan: string;
            // "英语（美国）"
            lan_doc: string;
            subtitle_url: string;
            subtitleASSURL: string
          }> = [];
  
          // copy from https://github.com/IndieKKY/bilibili-subtitle/blob/eaf465a6a94872682fdb08f27404b16749aab7e2/src/chrome/content-script.cjs
          const pages = await fetch(
            `https://api.bilibili.com/x/player/pagelist?aid=${aid}`,
            { credentials: 'include' },
          )
            .then((res) => res.json())
            .then((res) => res.data);
  
          const subtitleCid = pages[0].cid;
  
          await fetch(
            `https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${subtitleCid}`,
            { credentials: 'include' },
          )
            .then((res) => res.json())
            .then((res) => {
              subtitles = res.data.subtitle.subtitles;
            });
  
          return {
            subtitles,
            cid,
            aid,
            bvid,
          };
        });
  
        const { aid, bvid, cid, subtitles } = videoInfo;
        // TODO: if no subtitles, download from open subtitle
        if (subtitles?.length) {
          for (const subtitle of subtitles) {
            const subtitleJSONData = await fetch(
              `https://${subtitle.subtitle_url}`,
            ).then((res) => res.json());
            const srtFormat = generateSrtSubtitle(subtitleJSONData);
            const srtFile = path.resolve(
              __dirname,
              '../../',
              'temp',
              trimSpecial(`${comedianName}-${specialName}-${subtitle.lan}.srt`),
            );
            const assFileName = trimSpecial(`${comedianName}-${specialName}-${subtitle.lan}.ass`)
  
            const assFile = path.resolve(
              __dirname,
              '../../',
              'temp',
              assFileName
            );
            await fs.writeFile(srtFile, srtFormat);
            await new Promise((r) => {
              srtToAss.convert(srtFile, assFile, {}, (error: any) => {
                r(null)
              });                  
            })
            // create container client
            const containerClient = blobServiceClient.getContainerClient(containerName);
  
            // create blob client
            const blobClient = containerClient.getBlockBlobClient(assFileName);
  
            // upload file
            await blobClient.uploadFile(assFile);
            
            subtitle.subtitleASSURL = `https://standup-wiki.azureedge.net/${assFileName}`
          }
        }
  
        const iframeUrl = `//player.bilibili.com/player.html?aid=${aid}&bvid=${bvid}&cid=${cid}&high_quality=1&autoplay=false`;
  
        await bilibiliPage.close()
  
        return {
          iframeUrl,
          subtitles,
          cid,
          aid,
          bvid,
        };
      }      
    } else {
      logger.log('info', 'no bilibili result', specialName, comedianName)
      console.log('info', 'no bilibili result', specialName, comedianName)
      await bilibiliPage.close()
      return {}
    }
  } catch (error) {
    logger.log('info', 'bilibili error', specialName, comedianName, error)
    console.log('info', 'bilibili error', specialName, comedianName, error)
    await bilibiliPage.close()
    return {}
  }
}
