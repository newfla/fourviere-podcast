import { create } from "zustand";
import { produce } from "immer";
import { v4 as uuidv4 } from "uuid";
import { loadState, persistState } from "../persister";
import { parseXML } from "@fourviere/core/lib/converter";
import {
  FEED_TEMPLATE,
  EPISODE_TEMPLATE,
  PROJECT_BASE_CONFIGURATION,
  DEFAULT_FEED_FILENAME,
} from "@fourviere/core/lib/const";
import { fetchFeed } from "../../native/network";
import { Project } from "./types";

export interface FeedState {
  projects: Record<string, Project>;

  createProject: () => void;
  initProjectFromUrl: (feedUrl: string) => Promise<void>;
  initProjectFromFileContents: (feed: string) => void;

  deleteProject: (id: string) => void;
  getProjectById: (id: string) => Project;

  updateFeed: (id: string, feed: Project["feed"]) => void;
  patchFeedFromUrl: (id: string, feedUrl: string) => Promise<void>;
  patchFeedFromFileContents: (id: string, feed: string) => void;

  updateConfiguration: (
    id: string,
    configuration: Project["configuration"],
  ) => void;

  addEpisodeToProject: (feed: string) => void;
  deleteEpisodeFromProject: (feed: string, episodeGUID: string) => void;
}

const feedStore = create<FeedState>((set, get) => {
  return {
    projects: {},
    getProjectById: (id) => {
      return get().projects[id];
    },

    createProject: () => {
      const feed = parseXML(FEED_TEMPLATE);
      set((state: FeedState) => {
        return produce(state, (draft) => {
          const id = uuidv4();
          draft.projects[id] = {
            feed,
            configuration: PROJECT_BASE_CONFIGURATION,
          };
        });
      });
    },

    deleteProject: (id: string) => {
      set((state: FeedState) => {
        return produce(state, (draft) => {
          delete draft.projects[id];
        });
      });
    },

    initProjectFromUrl: async (feedUrl) => {
      const data = await fetchFeed(feedUrl);
      if (!data) return;
      const feed = parseXML(data);
      set((state: FeedState) => {
        return produce(state, (draft) => {
          const filename = feedUrl.split("/").pop() || DEFAULT_FEED_FILENAME;

          const id = uuidv4();
          const configuration = {
            ...PROJECT_BASE_CONFIGURATION,
            feed: { ...PROJECT_BASE_CONFIGURATION.feed, filename },
          };
          draft.projects[id] = { feed, configuration };
          draft.projects[id].configuration.feed.filename = filename;
          // Update LastFeedUpdate to induce a modification in the last 10 seconds
          draft.projects[id].configuration.meta.lastFeedUpdate = new Date();
        });
      });
    },

    initProjectFromFileContents: (fileContents) => {
      const feed = parseXML(fileContents);
      set((state: FeedState) => {
        return produce(state, (draft) => {
          const id = uuidv4();
          draft.projects[id] = {
            feed,
            configuration: PROJECT_BASE_CONFIGURATION,
          };
          // Update LastFeedUpdate to induce a modification in the last 10 seconds
          draft.projects[id].configuration.meta.lastFeedUpdate = new Date();
        });
      });
    },

    updateFeed: (id: string, feed: Project["feed"]) => {
      console.log("updateFeed", id);
      set((state: FeedState) => {
        return produce(state, (draft) => {
          draft.projects[id].feed = feed;
          draft.projects[id].feed.rss.channel[0].lastBuildDate =
            new Date().toUTCString();
          draft.projects[id].configuration.meta.lastFeedUpdate = new Date();
          draft.projects[id].configuration.meta.feedIsDirty = true;
        });
      });
    },

    patchFeedFromUrl: async (id, feedUrl) => {
      const data = await fetchFeed(feedUrl);
      if (!data) return;
      const feed = parseXML(data);
      set((state: FeedState) => {
        return produce(state, (draft) => {
          draft.projects[id].feed = feed;
          draft.projects[id].configuration.meta.lastFeedUpdate = new Date();
          draft.projects[id].configuration.meta.feedIsDirty = false;
        });
      });
    },

    patchFeedFromFileContents: (id, fileContents) => {
      const feed = parseXML(fileContents);
      set((state: FeedState) => {
        return produce(state, (draft) => {
          draft.projects[id].feed = feed;
          draft.projects[id].configuration.meta.lastFeedUpdate = new Date();
          draft.projects[id].configuration.meta.feedIsDirty = false;
        });
      });
    },

    updateConfiguration: (
      id: string,
      configuration: Project["configuration"],
    ) => {
      set((state: FeedState) => {
        return produce(state, (draft) => {
          draft.projects[id].configuration = configuration;
        });
      });
    },

    deleteEpisodeFromProject: (id: string, episodeGUID: string) => {
      set((state: FeedState) => {
        return produce(state, (draft) => {
          draft.projects[id].feed.rss.channel[0].item = draft.projects[
            id
          ].feed.rss.channel[0].item?.filter(
            (item) => item.guid["#text"] !== episodeGUID,
          );
        });
      });
    },

    addEpisodeToProject: (id: string) => {
      set((state: FeedState) => {
        return produce(state, (draft) => {
          if (!draft.projects[id].feed.rss.channel[0].item) {
            draft.projects[id].feed.rss.channel[0].item = [];
          }
          draft.projects[id].feed.rss.channel[0].item?.unshift(
            EPISODE_TEMPLATE(),
          );
        });
      });
    },
  };
});

// Extract feed keys from feeds
loadState<string[]>("feeds").then((keys) => {
  if (!keys) return;
  // Load each project file
  Promise.all(
    keys.map(async (key) => {
      const proj = await loadState<Project>(key);
      if (proj)
        return {
          id: key,
          proj: proj,
        };
    }),
  ).then((records) => {
    //Remove undefined elements
    const records_cleaned = records.flatMap((f) => (f ? [f] : []));
    const state: Partial<FeedState> = { projects: {} };

    //Build project records
    records_cleaned.reduce((acc, curr) => {
      if (acc) acc[curr.id] = curr.proj;
      return acc;
    }, state.projects);
    feedStore.setState(state);
  });
});

feedStore.subscribe((state) => {
  const timeGuard = new Date().getTime();
  Object.entries(state.projects).forEach(([key, value]) => {
    const lastTimeSaved = new Date(
      value.configuration.meta.lastFeedUpdate,
    ).getTime();
    // Only one record at time will be persisted
    if (timeGuard - lastTimeSaved <= 10000) {
      persistState(key, value).catch((e) => {
        console.error("Error persisting state", e);
      });
    }
  });

  //Store feed keys
  persistState("feeds", Object.keys(state.projects)).catch((e) => {
    console.error("Error persisting state", e);
  });
});

export default feedStore;
