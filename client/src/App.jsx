import { useEffect, useState } from "react";
import {
  NavLink,
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  Compass,
  LibraryBig,
  Download,
  BarChart3,
  Search,
  ArrowUpRight,
  AudioLines,
  X,
} from "lucide-react";
import Analytics from "./Analytics";
import { Downloads, PwaStatus } from "./Downloads";
import { Brand, Player } from "./components";
import { Discover, MyLibrary, StoryDetails, NotFound } from "./pages";
import { useLibrary } from "./LibraryContext";
export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const library = useLibrary();
  const [search, setSearch] = useState("");
  useEffect(() => {
    setSearch(new URLSearchParams(location.search).get("q") || "");
  }, [location.search]);
  useEffect(() => {
    if (location.hash)
      document.getElementById(location.hash.slice(1))?.scrollIntoView();
    else window.scrollTo({ top: 0 });
  }, [location.pathname, location.hash]);
  function submit(event) {
    event.preventDefault();
    const query = search.trim();
    navigate(query ? `/?q=${encodeURIComponent(query)}` : "/");
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="nav-label">YOUR DAILY ESCAPE</div>
        <nav aria-label="Main navigation">
          <NavLink to="/" end>
            <Compass size={20} />
            Discover
          </NavLink>
          <NavLink to="/library">
            <LibraryBig size={20} />
            My library
            <span className="nav-count">{library.stories.length}</span>
          </NavLink>
          <NavLink to="/downloads">
            <Download size={20} />
            Downloads
          </NavLink>
          <NavLink to="/analytics">
            <BarChart3 size={20} />
            Insights
          </NavLink>
        </nav>
        <div className="sidebar-card">
          <div className="sidebar-wave">
            <AudioLines size={30} />
            <span>✦</span>
          </div>
          <strong>A world in every story.</strong>
          <p>
            Put on your headphones.
            <br />
            Leave the ordinary behind.
          </p>
          <Link to="/#browse">
            Find your next listen <ArrowUpRight size={15} />
          </Link>
        </div>
        <div className="sidebar-bottom">
          <span className="live-dot" /> Built for the love of stories
          <small>SOUNDWAVE · DEMO COLLECTION</small>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="mobile-brand">
            <Brand />
          </div>
          <span className="breadcrumb">Your world, on play.</span>
          <form role="search" className="search-form" onSubmit={submit}>
            <Search size={18} />
            <input
              aria-label="Search story titles or genres"
              placeholder="Search stories, genres…"
              value={search}
              maxLength={100}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setSearch("");
                  if (location.search.includes("q=")) navigate("/");
                }}
              >
                <X size={15} />
              </button>
            )}
            <button
              className="search-submit"
              aria-label="Search stories"
              type="submit"
            >
              ↵
            </button>
          </form>
          <div className="demo-profile">
            <div className="avatar">D</div>
            <div>
              <strong>Demo listener</strong>
              <small>Your personal escape</small>
            </div>
          </div>
        </header>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          <NavLink to="/" end>
            <Compass size={17} />
            Discover
          </NavLink>
          <NavLink to="/library">
            <LibraryBig size={17} />
            My library
          </NavLink>
          <NavLink to="/downloads">
            <Download size={17} />
            Downloads
          </NavLink>
          <NavLink to="/analytics">
            <BarChart3 size={17} />
            Insights
          </NavLink>
        </nav>
        <main id="main-content">
          <PwaStatus />
          <div className="library-alert">
            {library.error && location.pathname !== "/library" && (
              <div role="alert">
                {library.error}
                <button onClick={library.refresh}>Retry</button>
              </div>
            )}
          </div>
          <Routes>
            <Route path="/" element={<Discover />} />
            <Route path="/library" element={<MyLibrary />} />
            <Route path="/downloads" element={<Downloads />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/stories/:id" element={<StoryDetails />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          <footer>
            <span>
              <AudioLines size={16} /> SoundWave{" "}
              <span className="footer-divider">/</span> Stories worth getting
              lost in.
            </span>
            <span>Original fiction. Real playback. Made to explore.</span>
          </footer>
        </main>
      </div>
      <Player />
    </div>
  );
}
