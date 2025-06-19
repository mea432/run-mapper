'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState, useRef } from 'react';
import '../styles/leaflet.css';
import type { LatLngExpression } from 'leaflet';
import 'leaflet-routing-machine/dist/leaflet-routing-machine.css';

// Dynamically import the map components with no SSR
const MapContainer = dynamic(
  () => import('react-leaflet').then((mod) => mod.MapContainer),
  { ssr: false }
);
const TileLayer = dynamic(
  () => import('react-leaflet').then((mod) => mod.TileLayer),
  { ssr: false }
);
const Marker = dynamic(
  () => import('react-leaflet').then((mod) => mod.Marker),
  { ssr: false }
);
const Popup = dynamic(
  () => import('react-leaflet').then((mod) => mod.Popup),
  { ssr: false }
);

// Fix for default marker icon
const icon = typeof window !== 'undefined' ? new (require('leaflet').Icon)({
  iconUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
}) : null;

// Custom waypoint icon
const waypointIcon = typeof window !== 'undefined' ? new (require('leaflet').Icon)({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
  iconRetinaUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
}) : null;

interface RouteInfo {
  distance: number;
}

// Conditionally import Leaflet and related plugins on the client side to avoid SSR issues
let L: any;
if (typeof window !== 'undefined') {
  // Dynamically require Leaflet (which expects window) only on the client
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  L = require('leaflet');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('leaflet-routing-machine');
}

interface MapWrapperProps {
  initialWaypoints?: [number, number][];
  viewOnly?: boolean;
}

export default function MapWrapper({ initialWaypoints = [], viewOnly = false }: MapWrapperProps) {
  const [position, setPosition] = useState<[number, number]>([51.505, -0.09]);
  const [isMounted, setIsMounted] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapStyle, setMapStyle] = useState<'standard' | 'satellite' | 'terrain'>('standard');
  const [waypoints, setWaypoints] = useState<[number, number][]>(initialWaypoints);
  const [history, setHistory] = useState<[number, number][][]>([initialWaypoints]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const waypointsRef = useRef<[number, number][]>([]);
  const [routeInfo, setRouteInfo] = useState<{ distance: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [useMiles, setUseMiles] = useState(false);
  const [showWelcomePopup, setShowWelcomePopup] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(5);
  const [progress, setProgress] = useState(0);
  const playerMarkerRef = useRef<any>(null);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const startTimeRef = useRef<number | undefined>(undefined);
  const routeCoordinatesRef = useRef<[number, number][]>([]);
  const mapRef = useRef<any>(null);
  const routingControlRef = useRef<any>(null);
  const routeSegmentsRef = useRef<any[]>([]);
  const trashAreaRef = useRef<HTMLDivElement>(null);
  const waypointMarkersRef = useRef<any[]>([]);
  const [isDraggingMarker, setIsDraggingMarker] = useState(false);
  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Address search inside welcome popup
  const [addressQuery, setAddressQuery] = useState('');
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // Share success state
  const [shareCopied, setShareCopied] = useState(false);
  const shareTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [showSharePopup, setShowSharePopup] = useState(false);
  const [shareLink, setShareLink] = useState('');

  // Loading indicator for long routes
  const [isRouteLoading, setIsRouteLoading] = useState(false);
  const [initialRouteLoaded, setInitialRouteLoaded] = useState(false);
  const [spinnerShown, setSpinnerShown] = useState(false);

  /* ---------------- Elevation profile ---------------- */
  const [elevationProfile, setElevationProfile] = useState<number[] | null>(null);
  const elevationCanvasRef = useRef<HTMLCanvasElement>(null);
  const [showElevation, setShowElevation] = useState<boolean>(false);
  const [elevationLoading, setElevationLoading] = useState(false);
  const [elevationError, setElevationError] = useState(false);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [hoverElevation, setHoverElevation] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [elevMin, setElevMin] = useState<number | null>(null);
  const [elevMax, setElevMax] = useState<number | null>(null);
  const [scaleMin, setScaleMin] = useState<number | null>(null);

  // Store smoothed elevation data for higher resolution queries
  const smoothedElevationRef = useRef<number[] | null>(null);

  // Helper to fetch elevation data (sampled to max 512 points)
  const fetchElevation = async (coords: [number, number][]) => {
    if (!coords || coords.length < 2) return;
    const maxSamples = 512;
    const sampleStep = Math.max(1, Math.floor(coords.length / maxSamples));
    const sampled = coords.filter((_, idx) => idx % sampleStep === 0);

    // Split into chunks of 100 coordinates to avoid URL length limits
    const chunkSize = 100;
    const chunks = [];
    for (let i = 0; i < sampled.length; i += chunkSize) {
      chunks.push(sampled.slice(i, i + chunkSize));
    }

    setElevationLoading(true);
    setElevationError(false);
    
    // Try each API in sequence with retries
    const tryFetch = async (api: 'opentopodata' | 'openelevation', chunk: [number, number][], retries = 2): Promise<any> => {
      for (let i = 0; i <= retries; i++) {
        try {
          const res = await fetch('/api/elevation', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
              locations: chunk,
              api
            })
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.json();
        } catch (err) {
          if (i === retries) throw err;
          await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // exponential backoff
        }
      }
    };

    try {
      // Try Open Elevation first (more reliable)
      const elevations: number[] = [];
      for (const chunk of chunks) {
        const json = await tryFetch('openelevation', chunk);
        if (!json?.results) throw new Error('invalid response');
        elevations.push(...json.results.map((r: any) => r.elevation ?? 0));
      }

      setElevationProfile(elevations);
      setElevMin(Math.min(...elevations));
      setElevMax(Math.max(...elevations));
    } catch (err) {
      console.warn('Primary elevation API failed:', err);
      // Fallback to OpenTopoData API
      try {
        const elevations: number[] = [];
        for (const chunk of chunks) {
          const json = await tryFetch('opentopodata', chunk);
          if (!json?.results) throw new Error('invalid response');
          elevations.push(...json.results.map((r: any) => r.elevation ?? 0));
        }
        setElevationProfile(elevations);
        setElevMin(Math.min(...elevations));
        setElevMax(Math.max(...elevations));
      } catch (err2) {
        console.error('Both elevation APIs failed:', err2);
        setElevationError(true);
        setShowElevation(false);
      }
    } finally {
      setElevationLoading(false);
    }
  };

  // Draw elevation chart whenever profile updates
  useEffect(() => {
    if (!elevationProfile || !elevationCanvasRef.current) return;
    const canvas = elevationCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Set up canvas
    const w = canvas.width = canvas.offsetWidth;
    const h = canvas.height = canvas.offsetHeight;
    const canvasPaddingLeft = 0; // flush graph to axis on the left
    const canvasPaddingRight = 5; // small space on the right to avoid clipping
    const padding = { top: 20, right: canvasPaddingRight, bottom: 20, left: canvasPaddingLeft };
    const graphWidth = w - padding.left - padding.right;
    const graphHeight = h - padding.top - padding.bottom;
    
    ctx.clearRect(0, 0, w, h);
    
    // -------- Create Catmull-Rom spline samples (smoothed data) --------
    const rawMax = Math.max(...elevationProfile);
    const rawMin = Math.min(...elevationProfile);
    const rawRange = Math.max(1, rawMax - rawMin);

    // Precompute control points once for Catmull-Rom to Bezier conversion
    const getControlPoints = (vals: number[]) => {
      const cps: {cp1: number; cp2: number}[] = [];
      for (let i = 0; i < vals.length - 1; i++) {
        const p0 = vals[Math.max(0, i - 1)];
        const p1 = vals[i];
        const p2 = vals[i + 1];
        const p3 = vals[Math.min(vals.length - 1, i + 2)];
        const tension = 0.33;
        const cp1 = p1 + (p2 - p0) * tension / 2;
        const cp2 = p2 - (p3 - p1) * tension / 2;
        cps.push({cp1, cp2});
      }
      return cps;
    };

    const cps = getControlPoints(elevationProfile);

    const sampleCount = 512;
    const smoothed: number[] = [];
    for (let s = 0; s < sampleCount; s++) {
      const tGlobal = s / (sampleCount - 1);
      const segFloat = tGlobal * (elevationProfile.length - 1);
      const i = Math.min(elevationProfile.length - 2, Math.floor(segFloat));
      const localT = segFloat - i;

      const p1 = elevationProfile[i];
      const p2 = elevationProfile[i + 1];
      const cp1 = cps[i].cp1;
      const cp2 = cps[i].cp2;

      const oneMinusT = 1 - localT;
      const val = oneMinusT**3 * p1 + 3*oneMinusT**2*localT*cp1 + 3*oneMinusT*localT**2*cp2 + localT**3*p2;
      smoothed.push(val);
    }

    smoothedElevationRef.current = smoothed;

    const minElev = Math.min(...smoothed);
    const maxElev = Math.max(...smoothed);
    // Set bottom of scale to 0 or slightly below if there are negative values
    const scaleMin = minElev < 0 ? minElev * 1.1 : 0;
    const range = Math.max(1, maxElev - scaleMin);

    setElevMin(minElev);
    setElevMax(maxElev);
    setScaleMin(scaleMin);

    // --------- Draw from smoothed data ---------
    const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
    gradient.addColorStop(0, 'rgba(33, 150, 243, 0.8)');
    gradient.addColorStop(1, 'rgba(33, 150, 243, 0.2)');

    const xStep = graphWidth / (sampleCount - 1);

    // Filled area
    ctx.beginPath();
    ctx.moveTo(padding.left, h - padding.bottom);
    smoothed.forEach((elev, idx) => {
      const x = padding.left + idx * xStep;
      const y = padding.top + graphHeight - ((elev - scaleMin) / range) * graphHeight;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(padding.left + graphWidth, h - padding.bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Stroke line
    ctx.beginPath();
    smoothed.forEach((elev, idx) => {
      const x = padding.left + idx * xStep;
      const y = padding.top + graphHeight - ((elev - scaleMin) / range) * graphHeight;
      if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#2196F3';
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [elevationProfile]);

  // Handle hover on elevation bar
  const handleElevationHover = (clientX: number, bounding: DOMRect) => {
    if (!elevationProfile || elevationProfile.length === 0) return;
    if (!elevationCanvasRef.current) return;
    const canvasRect = elevationCanvasRef.current.getBoundingClientRect();
    const usableWidth = canvasRect.width; // full drawable width inside canvas
    const xRel = clientX - canvasRect.left; // relative to canvas left edge

    // Use smoothed sample grid to find exact index for perfect alignment
    const smoothedLen = smoothedElevationRef.current?.length || 1;
    const stepPx = usableWidth / (smoothedLen - 1);
    let idx = Math.round(xRel / stepPx);
    idx = Math.max(0, Math.min(smoothedLen - 1, idx));
    const ratio = idx / (smoothedLen - 1);
    const coordIndex = Math.floor(ratio * (routeCoordinatesRef.current.length - 1));
    const coord = routeCoordinatesRef.current[coordIndex];
    if (!coord) return;

    // Ensure player marker visible on map
    if (!playerMarkerRef.current) createPlayerMarker();
    playerMarkerRef.current?.setLatLng(coord);

    // Update hover UI states
    setHoverRatio(ratio);
    if (elevationProfile) {
      if (smoothedElevationRef.current && smoothedElevationRef.current.length > 1) {
        setHoverElevation(smoothedElevationRef.current[idx]);
      } else {
        const rawIdx = Math.floor(ratio * (elevationProfile.length - 1));
        setHoverElevation(elevationProfile[rawIdx]);
      }
      // Compute absolute X position for vertical line: align with canvas left
      const offset = canvasRect.left - bounding.left;
      setHoverX(offset + idx * stepPx);
    }
  };

  const searchAddress = async () => {
    clearRoute();
    if (!addressQuery.trim()) return;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addressQuery)}`);
      const data = await res.json();
      if (data && data.length > 0) {
        const { lat, lon } = data[0];
        const coords: [number, number] = [parseFloat(lat), parseFloat(lon)];
        setPosition(coords);
        if (mapRef.current) {
          mapRef.current.setView(coords, 15);
        }
        setShowWelcomePopup(false);
        clearRoute();
      } else {
        alert('Location not found. Please try a different address.');
      }
    } catch (err) {
      console.error(err);
      alert('Error fetching location.');
    }
  };

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const commitWaypoints = (newWps: [number, number][]) => {
    if (JSON.stringify(newWps) === JSON.stringify(waypointsRef.current)) return;

    // Update history
    setHistory(prev => {
      const trimmed = prev.slice(0, historyIndex + 1);
      return [...trimmed, newWps];
    });
      setHistoryIndex(prev => prev + 1);

    // Update state
    setWaypoints(newWps);

    // Immediately update current routing control to avoid stale route before effect runs
    const rc = routingControlRef.current;
    if (rc) {
      rc.setWaypoints(newWps.map(([lat,lng]) => L.latLng(lat,lng)));
      // Explicitly trigger routing in case internal debounce delays execution
      rc.route();
    }

    // If fewer than 2 waypoints remain, clear existing route visuals and info
    if (newWps.length < 2) {
      setRouteInfo(null);
      // Remove custom gradient segments
      routeSegmentsRef.current.forEach(seg => mapRef.current?.removeLayer(seg));
      routeSegmentsRef.current = [];

      // Clear stored route coordinates
      routeCoordinatesRef.current = [];
    }
  };

  const undo = () => {
    if (!canUndo) return;
    const newIdx = historyIndex - 1;
    setHistoryIndex(newIdx);
    setWaypoints(history[newIdx]);
  };

  const redo = () => {
    if (!canRedo) return;
    const newIdx = historyIndex + 1;
    setHistoryIndex(newIdx);
    setWaypoints(history[newIdx]);
  };

  // Clear current route and waypoints
  const clearRoute = () => {
    setWaypoints([]);
    setRouteInfo(null);
    routingControlRef.current?.setWaypoints([]);

    // Remove custom gradient segments
    routeSegmentsRef.current.forEach(seg => mapRef.current?.removeLayer(seg));
    routeSegmentsRef.current = [];

    // Clear stored route coordinates so zoom events won't redraw old path
    routeCoordinatesRef.current = [];

    // Reset history
    setHistory([[]]);
    setHistoryIndex(0);
    setInitialRouteLoaded(false);

    // Remove player marker if present
    if(playerMarkerRef.current && mapRef.current){
      mapRef.current.removeLayer(playerMarkerRef.current);
      playerMarkerRef.current = null;
    }

    // Reset animation/progress if active
    if(animationFrameRef.current){
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = undefined;
    }
    setIsPlaying(false);
    setProgress(0);
  };

  // Add helper function after clearRoute definition
  const requestUserLocation = () => {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser.');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        setPosition(coords);
        clearRoute();

        if (mapRef.current) {
          mapRef.current.setView(coords, 13);
        }

        setShowWelcomePopup(false);
      },
      async (err) => {
        console.error('Geolocation error:', err);

        let message = 'Unable to retrieve your location.';
        if (err && typeof err === 'object' && 'code' in err) {
          switch ((err as GeolocationPositionError).code) {
            case 1: // PERMISSION_DENIED
              message = 'Location permission denied. Please enable it in your browser settings.';
              break;
            case 2: // POSITION_UNAVAILABLE
              message = 'Location information is unavailable. Please try again later.';
              break;
            case 3: // TIMEOUT
              message = 'Location request timed out. Please try again.';
              break;
          }
        }

        // Attempt fallback to IP-based lookup so user still gets approximate centering
        try {
          const res = await fetch('https://ipapi.co/json/');
          const data = await res.json();
          if (data && data.latitude && data.longitude) {
            const coords: [number, number] = [parseFloat(data.latitude), parseFloat(data.longitude)];
            setPosition(coords);
            if (mapRef.current) {
              mapRef.current.setView(coords, 6);
            }
            // Close popup so user can continue
            setShowWelcomePopup(false);
            alert(message + '\nShowing approximate location based on IP.');
            return;
          }
        } catch (_) {
          /* ignore fallback failure */
        }

        alert(message);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  };

  useEffect(() => {
    setIsMounted(true);

    // Fetch IP-based location to center map roughly on the user's country (edit mode only)
    if (!viewOnly) {
      fetch('https://ipapi.co/json/')
        .then(res => res.json())
        .then(data => {
          if (data && data.latitude && data.longitude) {
            const coords: [number, number] = [parseFloat(data.latitude), parseFloat(data.longitude)];
            setPosition(coords);
            clearRoute();
            if (mapRef.current) {
              mapRef.current.setView(coords, 6); // Zoomed out to country-level
            }
          }
        })
        .catch(err => {
          console.error('IP location fetch failed:', err);
        });
    }
  }, [viewOnly]);

  // Update the waypoint change handler in the routing control setup
  useEffect(() => {
    if (!isMounted || !mapReady || !mapRef.current) return;

    // Create new routing control
    const routingControl = L.Routing.control({
      waypoints: waypoints.map(wp => L.latLng(wp[0], wp[1])),
      routeWhileDragging: !viewOnly,
      show: false,
      addWaypoints: false,
      fitSelectedRoutes: false,
      draggableWaypoints: !viewOnly,
      lineOptions: {
        styles: [{ color: '#80C4FF', weight: 4, opacity: 0.75 }],
        extendToWaypoints: true,
        missingRouteTolerance: 0
      },
      createMarker: function(i: number, wp: any) {
        const marker = createCustomMarker(i);
        marker.setLatLng(wp.latLng);
        waypointMarkersRef.current[i] = marker;

        marker.on('dragstart', () => {
          mapRef.current?.dragging.disable();
          setIsDraggingMarker(true);
          const startPos = marker.getLatLng();
          const origIdx = waypointsRef.current.findIndex(([lat, lng]) =>
            Math.abs(lat - startPos.lat) < 1e-10 && Math.abs(lng - startPos.lng) < 1e-10
          );
          (marker as any)._origIdx = origIdx;
        });

        marker.on('dragend', (e: any) => {
          mapRef.current?.dragging.enable();
          setIsDraggingMarker(false);

          const trashEl = trashAreaRef.current;
          if (!trashEl) return;

          const markerPosition = e.target.getLatLng();
          const containerPoint = mapRef.current.latLngToContainerPoint(markerPosition);
          const mapContainerRect = mapRef.current.getContainer().getBoundingClientRect();
          const trashRect = trashEl.getBoundingClientRect();
          const relativeTrashRect = {
            left: trashRect.left - mapContainerRect.left,
            right: trashRect.right - mapContainerRect.left,
            top: trashRect.top - mapContainerRect.top,
            bottom: trashRect.bottom - mapContainerRect.top,
          };
          const isInTrash = (
            containerPoint.x >= relativeTrashRect.left &&
            containerPoint.x <= relativeTrashRect.right &&
            containerPoint.y >= relativeTrashRect.top &&
            containerPoint.y <= relativeTrashRect.bottom
          );
          
          const idxToUpdate = (marker as any)._origIdx;
          if (idxToUpdate < 0 || idxToUpdate >= waypointsRef.current.length) return;

          let newWaypoints;
          if (isInTrash) {
            // Filter out the deleted waypoint
            newWaypoints = waypointsRef.current.filter((_, index) => index !== idxToUpdate);
          } else {
            // Update the position of the moved waypoint
            newWaypoints = [...waypointsRef.current];
            newWaypoints[idxToUpdate] = [markerPosition.lat, markerPosition.lng];
          }

          // State updated via commitWaypoints which handles routing update indirectly
          commitWaypoints(newWaypoints);
        });

        return marker;
      },
      language: 'en',
      router: L.Routing.osrmv1({
        serviceUrl: 'https://routing.openstreetmap.de/routed-foot/route/v1',
        profile: 'routed-foot'
      }),
      useZoomParameter: false,
      showAlternatives: false,
      altLineOptions: {
        styles: [
          { color: 'black', opacity: 0.15, weight: 9 },
          { color: 'white', opacity: 0.8, weight: 6 },
          { color: '#0075BE', opacity: 1, weight: 4 }
        ],
        extendToWaypoints: true,
        missingRouteTolerance: 0
      }
    }).addTo(mapRef.current);

    // Clear old custom segments as soon as a new routing operation starts
    routingControl.on('routingstart', () => {
      routeSegmentsRef.current.forEach(seg => mapRef.current?.removeLayer(seg));
      routeSegmentsRef.current = [];
      waypointMarkersRef.current = [];
      if (viewOnly && !spinnerShown) {
        setIsRouteLoading(true);
      }
    });

    // Add hover effects to route segments
    routingControl.on('routesfound', (e: any) => {
      const routes = e.routes;
      if (routes && routes.length > 0) {
        const route = routes[0];
        setRouteInfo({
          distance: route.summary.totalDistance / 1000
        });

        // Draw gradient route
        drawGradientRoute(route.coordinates);

        // Store route coordinates for animation
        routeCoordinatesRef.current = route.coordinates.map((coord: any) => [coord.lat, coord.lng]);

        // Auto-fit the map to the full route when in view-only mode.
        // Defer the fit by a tick to ensure the route is fully added to the map,
        // which is important for very long routes that take longer to render.
        if (viewOnly && mapRef.current) {
          const bounds = L.latLngBounds(route.coordinates);
          setTimeout(() => {
            if (mapRef.current) {
              mapRef.current.fitBounds(bounds, { padding: [60, 60] });
            }
          }, 200); // slight delay (200 ms) guarantees layers are ready
        }
        if (viewOnly && !spinnerShown) {
          setIsRouteLoading(false);
          setSpinnerShown(true);
        }

        fetchElevation(routeCoordinatesRef.current);
      }
    });

    // Add routing error listener
    routingControl.on('routingerror', () => {
      if (viewOnly && !spinnerShown) {
        setIsRouteLoading(false);
        setSpinnerShown(true);
      }
    });

    // Store the routing control instance
    routingControlRef.current = routingControl;

    // Update waypoints when they change
    routingControl.setWaypoints(waypoints.map(wp => L.latLng(wp[0], wp[1])));

    // In routingControl creation after stored instance, add map zoomend listener once when isMounted
    if(isMounted&&mapRef.current){
      mapRef.current.on('zoomend',()=>{
        drawGradientRoute(routeCoordinatesRef.current.map(c=>({lat:c[0],lng:c[1]})));
      });
    }

    return () => {
      if (mapRef.current) {
        mapRef.current.removeControl(routingControl);
        // Clean up segments
        routeSegmentsRef.current.forEach(segment => {
          mapRef.current.removeLayer(segment);
        });
        routeSegmentsRef.current = [];
      }
    };
  }, [isMounted, mapReady, waypoints, viewOnly]);

  // Add helper function to find closest segment and insert index
  const findClosestSegment = (clickPoint: [number, number], waypoints: [number, number][]) => {
    if (waypoints.length < 2) return null;

    let minDistance = Infinity;
    let insertIndex = -1;

    for (let i = 0; i < waypoints.length - 1; i++) {
      const start = waypoints[i];
      const end = waypoints[i + 1];
      
      // Calculate distance from click point to line segment
      const distance = distanceToSegment(clickPoint, start, end);
      
      if (distance < minDistance) {
        minDistance = distance;
        insertIndex = i + 1;
      }
    }

    // Get current zoom level
    const currentZoom = mapRef.current?.getZoom() || 13;
    
    // Scale threshold based on zoom level
    // At zoom level 13, threshold is 0.0005 (about 50 meters)
    // As zoom level decreases, threshold increases exponentially
    // But we maintain a minimum threshold of 0.001 (about 100 meters)
    const baseThreshold = 0.0005;
    const minThreshold = 0.001;
    const zoomFactor = Math.pow(2, 13 - currentZoom);
    const threshold = Math.max(minThreshold, baseThreshold * zoomFactor);

    console.log('Current zoom:', currentZoom, 'Threshold:', threshold, 'Distance:', minDistance);
    return minDistance < threshold ? insertIndex : null;
  };

  // Helper function to calculate distance from point to line segment
  const distanceToSegment = (point: [number, number], start: [number, number], end: [number, number]) => {
    const x = point[0];
    const y = point[1];
    const x1 = start[0];
    const y1 = start[1];
    const x2 = end[0];
    const y2 = end[1];

    const A = x - x1;
    const B = y - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const len_sq = C * C + D * D;
    let param = -1;

    if (len_sq !== 0) {
      param = dot / len_sq;
    }

    let xx, yy;

    if (param < 0) {
      xx = x1;
      yy = y1;
    } else if (param > 1) {
      xx = x2;
      yy = y2;
    } else {
      xx = x1 + param * C;
      yy = y1 + param * D;
    }

    const dx = x - xx;
    const dy = y - yy;

    return Math.sqrt(dx * dx + dy * dy);
  };

  // Disable click handling in view-only mode
  useEffect(() => {
    if (!isMounted || !mapRef.current || viewOnly) return;

    const clickHandler = (e: any) => {
      // If a double-click is potentially occurring, defer single-click action
      if (clickTimeoutRef.current) return;

      clickTimeoutRef.current = setTimeout(() => {
      const clickPoint: [number, number] = [e.latlng.lat, e.latlng.lng];
        const newWaypoints: [number, number][] = [...waypointsRef.current, clickPoint];
        commitWaypoints(newWaypoints);
        clickTimeoutRef.current = null;
      }, 250); // delay to distinguish from dblclick
    };

    mapRef.current.on('click', clickHandler);

    return () => {
      if (mapRef.current) {
        mapRef.current.off('click', clickHandler);
      }
    };
  }, [isMounted, waypoints, viewOnly]);

  // Double-click to insert waypoint on nearest segment
  useEffect(() => {
    if (!isMounted || !mapRef.current || viewOnly) return;

    // Disable default zoom on double-click to reuse for insertion
    if (mapRef.current.doubleClickZoom) {
      mapRef.current.doubleClickZoom.disable();
    }

    const dblClickHandler = (e: any) => {
      // Cancel pending single-click action
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
        clickTimeoutRef.current = null;
      }

      const clickPoint: [number, number] = [e.latlng.lat, e.latlng.lng];
      const wps = waypointsRef.current;
      if (wps.length < 2) return;

      let minDist = Infinity;
      let bestIdx = 1;
      for (let i = 0; i < wps.length - 1; i++) {
        const dist = distanceToSegment(clickPoint, wps[i], wps[i + 1]);
        if (dist < minDist) {
          minDist = dist;
          bestIdx = i + 1;
        }
      }

      const insertIndex = bestIdx;
      const newWaypoints = [...waypointsRef.current];
      newWaypoints.splice(insertIndex, 0, clickPoint);
      commitWaypoints(newWaypoints);
    };

    mapRef.current.on('dblclick', dblClickHandler);

    return () => {
      if (mapRef.current) {
        mapRef.current.off('dblclick', dblClickHandler);
      }
    };
  }, [isMounted, waypoints, viewOnly]);

  const getTileLayerUrl = () => {
    switch (mapStyle) {
      case 'satellite':
        return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
      case 'terrain':
        return 'https://stamen-tiles-{s}.a.ssl.fastly.net/terrain/{z}/{x}/{y}.jpg';
      default:
        return 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    }
  };

  const getTileLayerAttribution = () => {
    switch (mapStyle) {
      case 'satellite':
        return '&copy; <a href="https://www.esri.com/">Esri</a> &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community';
      case 'terrain':
        return 'Map tiles by <a href="http://stamen.com">Stamen Design</a>, <a href="http://creativecommons.org/licenses/by/3.0">CC BY 3.0</a> &mdash; Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
      default:
        return '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    }
  };

  const formatDistance = (distance: number) => {
    if (useMiles) {
      return `${(distance * 0.621371).toFixed(2)} mi`;
    }
    return `${distance.toFixed(2)} km`;
  };

  const createCustomMarker = (waypointIndex: number) => {
    // Determine color based on position
    let backgroundColor;
    if (waypointIndex === 0) {
      backgroundColor = '#4CAF50'; // Green for start
    } else if (waypointIndex === waypoints.length - 1) {
      backgroundColor = '#f44336'; // Red for end
    } else {
      backgroundColor = '#9e9e9e'; // Grey for intermediate points
    }

    const marker = L.divIcon({
      className: viewOnly ? 'custom-waypoint-marker' : 'custom-waypoint-marker draggable-waypoint',
      html: `
        <div style="
          background-color: ${backgroundColor};
          color: white;
          border-radius: 50%;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: bold;
          font-size: 12px;
          border: 2px solid white;
          box-shadow: 0 2px 4px rgba(0,0,0,0.2);
          cursor: ${viewOnly ? 'default' : 'move'} !important;
        ">
          ${waypointIndex + 1}
        </div>
      `,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
    return L.marker([0, 0], { 
      icon: marker,
      draggable: !viewOnly
    });
  };

  // Add player marker creation function
  const createPlayerMarker = () => {
    if (playerMarkerRef.current && mapRef.current) {
      mapRef.current.removeLayer(playerMarkerRef.current);
    }

    if (!mapRef.current) return;

    const playerIcon = L.divIcon({
      className: 'player-marker',
      html: `
        <div style="
          width: 24px;
          height: 24px;
          transform: rotate(0deg);
          transition: transform 0.1s linear;
        ">
          <svg viewBox="0 0 24 24" fill="#FF9800" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="8" />
          </svg>
        </div>
      `,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    playerMarkerRef.current = L.marker([0, 0], { icon: playerIcon }).addTo(mapRef.current);
  };

  // Add animation function
  const interpolate = (a: [number,number], b: [number,number], t:number):[number,number]=>[
      a[0] + (b[0]-a[0])*t,
      a[1] + (b[1]-a[1])*t
  ];

  const bearing = (a:[number,number], b:[number,number])=>{
      const lat1 = a[0]*Math.PI/180, lat2=b[0]*Math.PI/180;
      const dLon=(b[1]-a[1])*Math.PI/180;
      const y=Math.sin(dLon)*Math.cos(lat2);
      const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
      return (Math.atan2(y,x)*180/Math.PI+360)%360;
  };

  const animateRoute = (timestamp:number)=>{
    if(!startTimeRef.current){startTimeRef.current=timestamp;}
    const elapsed=timestamp-startTimeRef.current;
    const newProgress=Math.min(elapsed/(duration*1000),1);
      setProgress(newProgress);

    const coords=routeCoordinatesRef.current;
    if(coords.length<2){return;}
    const floatIndex=newProgress*(coords.length-1);
    const idx=Math.floor(floatIndex);
    const t=floatIndex-idx;
    const pos=idx<coords.length-1?interpolate(coords[idx],coords[idx+1],t):coords[coords.length-1];

    if(playerMarkerRef.current){
        playerMarkerRef.current.setLatLng(pos);
        // rotate
        const dir= idx<coords.length-1?bearing(coords[idx],coords[idx+1]):bearing(coords[idx-1],coords[idx]);
        const el=(playerMarkerRef.current.getElement()?.firstElementChild as HTMLElement | null);
        if(el){el.style.transform=`rotate(${dir}deg)`;}
    }

    if(newProgress<1){animationFrameRef.current=requestAnimationFrame(animateRoute);}else{
      setIsPlaying(false);
      setProgress(0);
        startTimeRef.current=undefined;
      if (playerMarkerRef.current && mapRef.current) {
        mapRef.current.removeLayer(playerMarkerRef.current);
        playerMarkerRef.current = null;
      }

        // Restore waypoint markers
        waypointMarkersRef.current.forEach(m=>m.setOpacity(1));
    }
  };

  // Add play/pause function
  const togglePlay = () => {
    if (isPlaying) {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      setIsPlaying(false);
      setProgress(0);
      startTimeRef.current = undefined;

      // Remove player marker immediately
      if (playerMarkerRef.current && mapRef.current) {
        mapRef.current.removeLayer(playerMarkerRef.current);
        playerMarkerRef.current = null;
      }

      // Restore waypoint markers
      waypointMarkersRef.current.forEach(m=>m.setOpacity(1));
    } else {
      if (routeCoordinatesRef.current.length > 0) {
        createPlayerMarker();

        // Hide intermediate waypoint markers
        waypointMarkersRef.current.forEach((m, idx)=>{
          if(idx!==0 && idx!== waypointMarkersRef.current.length-1){
            m.setOpacity(0);
          }
        });

        // Fit the map to the full route with padding for nice overview
        if(mapRef.current){
          const bounds = L.latLngBounds(routeCoordinatesRef.current);
          mapRef.current.fitBounds(bounds, { 
            paddingTopLeft: [60, 60],
            paddingBottomRight: [60, 180]  // extra bottom space for control panel
          });
        }

        setIsPlaying(true);
        startTimeRef.current = undefined;
        animationFrameRef.current = requestAnimationFrame(animateRoute);
      }
    }
  };

  // Clean up animation on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // Sync waypoints state into ref so event handlers have current data
  useEffect(() => {
    waypointsRef.current = waypoints;
  }, [waypoints]);

  // Insert helper after routeSegmentsRef declaration
  const drawGradientRoute = (coords:any[])=>{
    routeSegmentsRef.current.forEach(seg=>mapRef.current?.removeLayer(seg));
    routeSegmentsRef.current=[];
    if(!coords||coords.length<2)return;
    const startColor=[0,117,190];
    const endColor=[128,196,255];
    const lerp=(a:number,b:number,t:number)=>Math.round(a+(b-a)*t);
    for(let i=0;i<coords.length-1;i++){
      const t=i/(coords.length-2);
      const color=`rgb(${lerp(startColor[0],endColor[0],t)},${lerp(startColor[1],endColor[1],t)},${lerp(startColor[2],endColor[2],t)})`;
      const seg=L.polyline([coords[i],coords[i+1]],{color,weight:5,opacity:1,interactive:false}).addTo(mapRef.current);
      routeSegmentsRef.current.push(seg);
    }
  };

  // ---------- Share route helpers ----------
  const copyShareLink = () => {
    if (!shareLink) return;
    const copyToClipboard = async (text: string) => {
      try {
        // Try using the Clipboard API first
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(text);
          return true;
        }

        // Fallback to textarea method
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
          document.body.removeChild(textarea);
          return true;
        } catch (err) {
          document.body.removeChild(textarea);
          return false;
        }
      } catch (err) {
        return false;
      }
    };

    copyToClipboard(shareLink)
      .then((success) => {
        if (!success) {
          alert('Failed to copy. Please try selecting and copying the link manually.');
          return;
        }
        setShareCopied(true);
        if (shareTimeoutRef.current) clearTimeout(shareTimeoutRef.current);
        shareTimeoutRef.current = setTimeout(() => setShareCopied(false), 2000);
      })
      .catch((err) => {
        console.error('Failed to copy:', err);
        alert('Failed to copy share link. Please try again.');
      });
  };

  const nativeShare = () => {
    if (!shareLink) return;
    if (navigator.share) {
      navigator.share({
        title: 'My Route',
        url: shareLink,
      }).catch((err) => {
        // Gracefully handle user cancelling the share sheet
        if (err && err.name !== 'AbortError') {
          console.error('Native share failed:', err);
        }
      });
    } else {
      copyShareLink();
    }
  };

  const shareRoute = () => {
    if (waypoints.length === 0) {
      alert('Please create a route before sharing.');
      return;
    }

    const routeData = encodeURIComponent(JSON.stringify(waypoints));
    const url = `${window.location.origin}/route?route=${routeData}`;
    setShareLink(url);
    setShowSharePopup(true);
  };

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (shareTimeoutRef.current) clearTimeout(shareTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (addressQuery.trim().length < 3) {
      setSuggestions([]);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(addressQuery)}&limit=5`);
        const data = await res.json();
        setSuggestions(data);
      } catch (err) {
        console.error(err);
      }
    }, 300);
  }, [addressQuery]);

  const selectSuggestion = (item: any) => {
    setAddressQuery(item.display_name);
    setSuggestions([]);
    const coords: [number, number] = [parseFloat(item.lat), parseFloat(item.lon)];
    setPosition(coords);
    clearRoute();
    if (mapRef.current) {
      mapRef.current.setView(coords, 15);
    }
    setShowWelcomePopup(false);
  };

  // Hide elevation profile when profile data is cleared
  useEffect(() => {
    if (!elevationProfile) {
      setShowElevation(false);
    }
  }, [elevationProfile]);

  // Helper to calculate nice tick intervals
  const calculateTicks = (min: number, max: number, targetCount: number = 5): number[] => {
    const range = max - min;
    const roughStep = range / (targetCount - 1);
    
    // Nice step values
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
    let step = steps[0];
    
    // Find the first step size that gives us at most targetCount ticks
    for (const s of steps) {
      if (range / s <= targetCount) {
        step = s;
        break;
      }
    }

    // Calculate the nice min and max values
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    
    // Generate ticks
    const ticks: number[] = [];
    for (let tick = niceMin; tick <= niceMax; tick += step) {
      ticks.push(tick);
    }
    
    return ticks;
  };

  if (!isMounted) {
    return <div style={{ height: '100dvh', width: '100%', overflow: 'hidden' }}>Loading map...</div>;
  }

  return (
    <div style={{ height: '100dvh', width: '100%', position: 'relative', overflow: 'hidden' }}>
      <style dangerouslySetInnerHTML={{ __html: `
        .leaflet-routing-container {
          display: none !important;
        }
        .draggable-waypoint {
          cursor: move !important;
        }
        .draggable-waypoint:hover {
          cursor: move !important;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}} />
      
      {/* Welcome Popup - only show in edit mode */}
      {showWelcomePopup && !viewOnly && (
        <div style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'white',
          padding: '20px',
          borderRadius: '16px',
          boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
          zIndex: 2000,
          maxWidth: '90%',
          width: 'min(550px, 90vw)',
          maxHeight: '90vh',
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch', // Smooth scrolling on iOS
          display: 'flex',
          flexDirection: 'column',
          gap: '16px'
        }}>
          <h2 style={{ 
            margin: 0, 
            color: '#2196F3',
            fontSize: 'clamp(24px, 5vw, 28px)',
            fontWeight: '600',
            fontFamily: 'var(--font-geist-sans)'
          }}>
            Welcome to Route Planner!
          </h2>
          <p style={{ 
            fontSize: 'clamp(14px, 3vw, 16px)', 
            lineHeight: '1.6',
            color: '#4a5568',
            margin: 0,
            fontFamily: 'var(--font-geist-sans)'
          }}>
            Create and plan your running and biking routes with ease. Here's what you can do:
          </p>
          <ul style={{ 
            paddingLeft: '24px',
            fontSize: 'clamp(13px, 2.5vw, 15px)',
            lineHeight: '1.8',
            margin: 0,
            color: '#4a5568',
            fontFamily: 'var(--font-geist-sans)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}>
            <li>
              <strong style={{ color: '#2196F3' }}>Click anywhere</strong> on the map to add waypoints and build your route.
            </li>
            <li>
              <strong style={{ color: '#2196F3' }}>Drag waypoints</strong> to fine-tune the path in real time.
            </li>
            <li>
              <strong style={{ color: '#2196F3' }}>Undo / Redo</strong> with the green/blue buttons if you change your mind.
            </li>
            <li>
              The route is drawn with a <strong style={{ color: '#2196F3' }}>blue → light-blue gradient</strong> so overlaps are clear.
            </li>
            <li>
              Press <strong style={{ color: '#2196F3' }}>Play</strong> to watch an orange dot animate along the route.
            </li>
            <li>
              Scroll to <strong style={{ color: '#2196F3' }}>zoom</strong>; the map auto-fits the route at playback start.
            </li>
            <li>
              <strong style={{ color: '#2196F3' }}>Switch map style</strong>: Standard • Satellite • Terrain.
            </li>
            <li>
              Click the distance badge to toggle <strong style={{ color: '#2196F3' }}>km / miles</strong>.
            </li>
            <li>
              <strong style={{ color: '#2196F3' }}>Use My Location</strong> to automatically set your current location.
            </li>
          </ul>

          {/* Address search */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ fontSize: 'clamp(13px, 2.5vw, 15px)', fontWeight: 500, color: '#4a5568', fontFamily: 'var(--font-geist-sans)' }}>
              Jump to an address
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                value={addressQuery}
                onChange={(e) => setAddressQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') searchAddress(); }}
                placeholder="1600 Amphitheatre Pkwy, Mountain View"
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  border: '1px solid #ccc',
                  borderRadius: '8px',
                  fontSize: 'clamp(14px, 3vw, 16px)',
                  fontFamily: 'var(--font-geist-sans)'
                }}
              />
          <button
                onClick={searchAddress}
            style={{
              padding: '10px 20px',
                  backgroundColor: '#4CAF50',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: 'clamp(14px, 3vw, 16px)',
                  fontWeight: '500',
                  transition: 'background-color 0.2s',
                  fontFamily: 'var(--font-geist-sans)'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#43A047')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#4CAF50')}
              >
                Go
              </button>
            </div>

            {suggestions.length > 0 && (
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  maxHeight: '150px',
                  overflowY: 'auto',
                  border: '1px solid #e0e0e0',
                  borderRadius: '8px',
                  backgroundColor: 'white',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.1)'
                }}
              >
                {suggestions.map((s, idx) => (
                  <li
                    key={idx}
                    onClick={() => selectSuggestion(s)}
                    style={{
                      padding: '10px 12px',
                      cursor: 'pointer',
                      fontSize: 'clamp(13px, 2.5vw, 15px)',
                      fontFamily: 'var(--font-geist-sans)',
                      borderBottom: idx !== suggestions.length - 1 ? '1px solid #f0f0f0' : 'none'
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLLIElement).style.backgroundColor = '#f5f5f5';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLLIElement).style.backgroundColor = 'white';
                    }}
                  >
                    {s.display_name}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div style={{
            display: 'flex',
            gap: '12px',
            marginTop: '8px'
          }}>
            <button
              onClick={() => {
                setShowWelcomePopup(false);
                requestUserLocation();
                clearRoute();
              }}
              style={{
                padding: '12px 20px',
              backgroundColor: '#2196F3',
              color: 'white',
              border: 'none',
                borderRadius: '8px',
              cursor: 'pointer',
                fontSize: 'clamp(14px, 3vw, 16px)',
                fontWeight: '500',
                flex: 1,
                transition: 'background-color 0.2s',
                fontFamily: 'var(--font-geist-sans)'
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#1976D2'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#2196F3'}
            >
              Use My Location
            </button>
            <button
              onClick={() => {
                setShowWelcomePopup(false);
                clearRoute();
              }}
              style={{
                padding: '12px 20px',
                backgroundColor: '#f5f5f5',
                color: '#333',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: 'clamp(14px, 3vw, 16px)',
                fontWeight: '500',
                flex: 1,
                transition: 'background-color 0.2s',
                fontFamily: 'var(--font-geist-sans)'
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#e0e0e0'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#f5f5f5'}
            >
              Skip
          </button>
          </div>
        </div>
      )}

      {!viewOnly && (
      <div style={{ position: 'absolute', top: '10px', right: '10px', zIndex: 1000, display: 'flex', gap: '10px' }}>
          <button
            onClick={shareRoute}
            style={{
              padding: '10px 20px',
              backgroundColor: '#4CAF50',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
              transition: 'background-color 0.3s ease',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            {shareCopied ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg 
                width="16" 
                height="16" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                strokeWidth="2" 
                strokeLinecap="round" 
                strokeLinejoin="round"
              >
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path>
                <polyline points="16 6 12 2 8 6"></polyline>
                <line x1="12" y1="2" x2="12" y2="15"></line>
              </svg>
            )}
          </button>
          <button
            onClick={clearRoute}
            style={{
              padding: '10px 20px',
              backgroundColor: '#ff4444',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
              transition: 'background-color 0.3s ease'
            }}
          >
            Clear Route
          </button>
        <button
          onClick={undo}
          disabled={!canUndo}
          style={{
            padding: '10px 20px',
            backgroundColor: canUndo ? '#4CAF50' : '#cccccc',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: canUndo ? 'pointer' : 'not-allowed',
              opacity: canUndo ? 1 : 0.6
          }}
        >
          Undo
        </button>
        <button
          onClick={redo}
          disabled={!canRedo}
          style={{
            padding: '10px 20px',
            backgroundColor: canRedo ? '#2196F3' : '#cccccc',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: canRedo ? 'pointer' : 'not-allowed',
              opacity: canRedo ? 1 : 0.6
          }}
        >
          Redo
        </button>
          <select
            value={mapStyle}
            onChange={(e) => setMapStyle(e.target.value as 'standard' | 'satellite' | 'terrain')}
          style={{
              padding: '10px',
            borderRadius: '4px',
              border: '1px solid #ccc',
              backgroundColor: 'white',
              cursor: 'pointer'
            }}
          >
            <option value="standard">Standard Map</option>
            <option value="satellite">Satellite</option>
            <option value="terrain">Terrain</option>
          </select>
        </div>
      )}

      {/* Always show map style selector in a different position when in view-only mode */}
      {viewOnly && (
        <div style={{ position: 'absolute', top: '20px', right: '10px', zIndex: 1000 }}>
        <select
          value={mapStyle}
          onChange={(e) => setMapStyle(e.target.value as 'standard' | 'satellite' | 'terrain')}
          style={{
            padding: '10px',
            borderRadius: '4px',
            border: '1px solid #ccc',
            backgroundColor: 'white',
            cursor: 'pointer'
          }}
        >
          <option value="standard">Standard Map</option>
          <option value="satellite">Satellite</option>
          <option value="terrain">Terrain</option>
        </select>
      </div>
      )}

      {routeInfo && (
        <div 
          style={{ 
            position: 'absolute', 
            top: '70px', 
            right: '10px', 
            zIndex: 1000,
            backgroundColor: 'white',
            padding: '10px 15px',
            borderRadius: '4px',
            boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
            cursor: 'pointer',
            userSelect: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            transition: 'all 0.2s ease',
            border: '1px solid #e0e0e0'
          }}
          onClick={() => setUseMiles(!useMiles)}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#f5f5f5';
            e.currentTarget.style.boxShadow = '0 4px 8px rgba(0,0,0,0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'white';
            e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
          }}
        >
          <p style={{ margin: 0 }}>Distance: {formatDistance(routeInfo.distance)}</p>
          <svg 
            width="16" 
            height="16" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
            style={{ opacity: 0.6 }}
          >
            <path d="M7 7h10v10"></path>
            <path d="M7 17 17 7"></path>
          </svg>
        </div>
      )}
      
      <MapContainer
        center={position}
        zoom={13}
        style={{ height: '100%', width: '100%' }}
        ref={(m: any) => { if(m){ mapRef.current = m; setMapReady(true);} }}
        dragging={true}
        zoomControl={true}
        scrollWheelZoom={true}
      >
        <TileLayer
          attribution={getTileLayerAttribution()}
          url={getTileLayerUrl()}
        />
      </MapContainer>

      {/* Route Player Controls */}
      {routeInfo && (
        <div style={{
          position: 'absolute',
          bottom: showElevation ? '220px' : '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: 'white',
          padding: '15px',
          borderRadius: '8px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          zIndex: 1000,
          display: 'flex',
          alignItems: 'center',
          gap: '15px',
          minWidth: '300px',
          transition: 'bottom 0.3s',
        }}>
          <button
            onClick={togglePlay}
            style={{
              padding: '8px 16px',
              backgroundColor: isPlaying ? '#ff4444' : '#4CAF50',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            {isPlaying ? 'Stop' : 'Play Route'}
          </button>
          
          <div style={{ flex: 1 }}>
            <div style={{ 
              height: '4px', 
              backgroundColor: '#e0e0e0', 
              borderRadius: '2px',
              position: 'relative'
            }}>
              <div style={{
                position: 'absolute',
                left: 0,
                top: 0,
                height: '100%',
                width: `${progress * 100}%`,
                backgroundColor: '#4CAF50',
                borderRadius: '2px',
                transition: 'width 0.1s linear'
              }} />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={{ fontSize: '14px', color: '#666' }}>Duration:</label>
            <input
              type="number"
              value={duration}
              onChange={(e) => setDuration(Math.max(1, Math.min(60, Number(e.target.value))))}
              min="1"
              max="60"
              style={{
                width: '60px',
                padding: '4px 8px',
                border: '1px solid #ccc',
                borderRadius: '4px',
                fontSize: '14px'
              }}
            />
            <span style={{ fontSize: '14px', color: '#666' }}>sec</span>
          </div>
        </div>
      )}

      {/* Elevation Toggle Button (only when profile exists) */}
      {routeCoordinatesRef.current.length > 1 && (
        <button
          onClick={() => {
            if (elevationLoading || elevationError) return;
            setShowElevation(!showElevation);
          }}
          style={{
            position: 'absolute',
            bottom: showElevation ? '220px' : '20px',
            left: '20px',
            transform: 'none',
            padding: '8px 14px',
            backgroundColor: elevationLoading || elevationError ? '#888' : '#2196F3',
            color: 'white',
            border: 'none',
            borderRadius: '20px',
            cursor: elevationLoading || elevationError ? 'not-allowed' : 'pointer',
            zIndex: 1000,
            transition: 'bottom 0.3s'
          }}
        >
          {elevationLoading ? 'Loading...' : elevationError ? 'Elev. Unavailable' : showElevation ? 'Hide Elevation' : 'Show Elevation'}
        </button>
      )}

      {/* Trash can area - only show when dragging a marker */}
      {isDraggingMarker && (
        <div
          ref={trashAreaRef}
          style={{
            position: 'absolute',
            bottom: showElevation ? '220px' : '20px',
            right: '20px',
            width: '120px',
            height: '120px',
            backgroundColor: 'rgba(255, 68, 68, 0.15)',
            border: '2px dashed #ff4444',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 1000,
            transition: 'background-color 0.2s ease-in-out',
            flexDirection: 'column',
            gap: '8px'
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ff4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
          <div style={{ color: '#ff4444', fontSize: '14px', fontWeight: 'bold' }}>
            Delete
          </div>
        </div>
      )}

      {/* Loading indicator for long routes */}
      {viewOnly && isRouteLoading && !spinnerShown && (
        <>
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            backgroundColor: 'rgba(0,0,0,0.25)',
            backdropFilter: 'blur(3px)',
            zIndex: 1499,
            pointerEvents: 'none'
          }} />
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '48px',
            height: '48px',
            border: '6px solid #e0e0e0',
            borderTop: '6px solid #2196F3',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            zIndex: 1500,
            pointerEvents: 'none'
          }} />
        </>
      )}

      {/* Elevation Profile Bar */}
      {elevationProfile && elevationProfile.length > 1 && (
        <div style={{
          position: 'absolute',
          bottom: showElevation ? '0px' : '-500px',
          left: 0,
          width: '100%',
          height: '180px',
          backgroundColor: 'white',
          borderTop: '1px solid #e0e0e0',
          boxShadow: '0 -2px 10px rgba(0,0,0,0.1)',
          zIndex: 999,
          display: 'flex',
          alignItems: 'center',
          transition: 'bottom 0.3s',
          padding: '15px',
          overflow: 'hidden'
        }}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            handleElevationHover(e.clientX, rect);
          }}
          onTouchMove={(e) => {
            if (e.touches.length > 0) {
              const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              handleElevationHover(e.touches[0].clientX, rect);
            }
          }}
          onMouseLeave={() => {
            setHoverRatio(null);
            setHoverX(null);
            if (playerMarkerRef.current && mapRef.current && !isPlaying) {
              mapRef.current.removeLayer(playerMarkerRef.current);
              playerMarkerRef.current = null;
            }
          }}
          onTouchEnd={() => {
            setHoverRatio(null);
            setHoverX(null);
            if (playerMarkerRef.current && mapRef.current && !isPlaying) {
              mapRef.current.removeLayer(playerMarkerRef.current);
              playerMarkerRef.current = null;
            }
          }}
        >
          {/* Axis */}
          <div style={{ 
            width: '60px', 
            height: '120px',
            marginRight: '10px',
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            borderRight: '1px solid #e0e0e0'
          }}>
            {/* Y-axis label */}
            <div style={{ 
              position: 'absolute',
              left: '-42px',
              top: '50%',
              transform: 'rotate(-90deg) translateX(50%)',
              transformOrigin: 'right',
              color: '#666',
              fontSize: '12px',
              whiteSpace: 'nowrap',
              fontWeight: '500'
            }}>
              Elevation {useMiles ? '(ft)' : '(m)'}
            </div>

            {/* Ticks container */}
            <div style={{
              position: 'absolute',
              right: '0',
              top: '0',
              bottom: '0',
              width: '100%'
            }}>
              {elevMax !== null && scaleMin !== null && (
                <>
                  {calculateTicks(scaleMin, elevMax).map((tick) => {
                    const percent = 1 - (tick - scaleMin) / (elevMax - scaleMin);
                    return (
                      <div
                        key={tick}
                        style={{
                          position: 'absolute',
                          right: '0',
                          top: `${percent * 100}%`,
                          width: '100%',
                          transform: 'translateY(-50%)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'flex-end'
                        }}
                      >
                        {/* Tick line */}
                        <div style={{
                          width: '4px',
                          height: '1px',
                          backgroundColor: '#ccc',
                          marginRight: '4px'
                        }} />
                        {/* Tick label */}
                        <span style={{
                          fontSize: '10px',
                          color: '#666',
                          marginRight: '8px',
                          fontFeatureSettings: '"tnum" 1',
                          fontFamily: 'monospace'
                        }}>
                          {useMiles 
                            ? `${Math.round(tick * 3.28084)}` 
                            : `${Math.round(tick)}`
                          }
                        </span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>

          {/* Graph area */}
          <div style={{ 
            flex: 1, 
            height: '120px', 
            position: 'relative',
            backgroundColor: '#fafafa',
            borderRadius: '4px'
          }}>
            <canvas ref={elevationCanvasRef} style={{ 
              width: '100%', 
              height: '100%',
              borderRadius: '4px'
            }} />
            
            {/* Distance axis label */}
            <div style={{
              position: 'absolute',
              bottom: '-24px',
              left: '0',
              width: '100%',
              textAlign: 'center',
              color: '#666',
              fontSize: '12px',
              fontWeight: '500'
            }}>
              Distance {useMiles ? '(mi)' : '(km)'}
            </div>
          </div>

          {/* Rest of the hover elements remain unchanged */}
          {hoverRatio !== null && hoverElevation !== null && (
            <>
              <div style={{
                position: 'absolute',
                left: `${hoverX ?? 0}px`,
                top: '15px',
                width: '1px',
                height: 'calc(100% - 30px)',
                backgroundColor: 'rgba(33, 150, 243, 0.5)',
                pointerEvents: 'none'
              }} />
              <div style={{
                position: 'absolute',
                left: `${hoverX ?? 0}px`,
                top: '5px',
                transform: 'translate(-50%, 0)',
                backgroundColor: 'rgba(33, 150, 243, 0.9)',
                color: '#fff',
                padding: '4px 8px',
                borderRadius: '4px',
                fontSize: '12px',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
              }}>
                {useMiles 
                  ? `${Math.round(hoverElevation * 3.28084)} ft` 
                  : `${Math.round(hoverElevation)} m`
                }
              </div>
            </>
          )}
        </div>
      )}

      {/* Share Popup Modal */}
      {showSharePopup && !viewOnly && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setShowSharePopup(false)}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              backgroundColor: 'rgba(0,0,0,0.4)',
              backdropFilter: 'blur(2px)',
              zIndex: 3000,
            }}
          />

          {/* Modal */}
          <div
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              backgroundColor: 'white',
              padding: '24px',
              borderRadius: '12px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
              zIndex: 3001,
              width: 'min(90%, 420px)',
              maxWidth: '420px',
              fontFamily: 'var(--font-geist-sans)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <h3 style={{ margin: 0 }}>Share this route</h3>

            <input
              type="text"
              readOnly
              value={shareLink}
              onClick={(e) => (e.target as HTMLInputElement).select()}
              style={{
                width: '100%',
                padding: '10px 12px',
                border: '1px solid #ccc',
                borderRadius: '8px',
                fontSize: '14px',
                boxSizing: 'border-box',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            />

            {shareCopied && (
              <span style={{ color: '#4CAF50', fontSize: '14px' }}>Copied to clipboard!</span>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={copyShareLink}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#4CAF50',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                Copy
              </button>
              {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                <button
                  onClick={nativeShare}
                  style={{
                    padding: '10px 20px',
                    backgroundColor: '#2196F3',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '14px',
                  }}
                >
                  Share
                </button>
              )}
              <button
                onClick={() => setShowSharePopup(false)}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#e0e0e0',
                  color: '#333',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                Close
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
} 