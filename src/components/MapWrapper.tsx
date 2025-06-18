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
    routingControlRef.current?.setWaypoints(newWps.map(([lat,lng]) => L.latLng(lat,lng)));
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
        // Center map if already initialized
        if (mapRef.current) {
          mapRef.current.setView(coords, 13);
        }
        // Close popup if still open
        setShowWelcomePopup(false);
      },
      (err) => {
        console.error(err);
        alert('Unable to retrieve your location.');
      }
    );
  };

  useEffect(() => {
    setIsMounted(true);
    
    // Get user's current position only in edit mode (not view-only)
    if (!viewOnly && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setPosition([position.coords.latitude, position.coords.longitude]);
        },
        (error) => {
          console.error('Error getting location:', error);
        }
      );
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

        // Auto-fit the map to the full route when in view-only mode
        if (viewOnly && mapRef.current) {
          const bounds = L.latLngBounds(route.coordinates);
          mapRef.current.fitBounds(bounds, { 
            padding: [60, 60]
          });
        }
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
      const clickPoint: [number, number] = [e.latlng.lat, e.latlng.lng];
      const newWaypoints: [number, number][] = [...waypointsRef.current, clickPoint];
      commitWaypoints(newWaypoints);
    };

    mapRef.current.on('click', clickHandler);

    return () => {
      if (mapRef.current) {
        mapRef.current.off('click', clickHandler);
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
      className: 'custom-waypoint-marker draggable-waypoint',
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
          cursor: move;
        ">
          ${waypointIndex + 1}
        </div>
      `,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
    return L.marker([0, 0], { 
      icon: marker,
      draggable: true
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

  // Add share route function
  const shareRoute = () => {
    if (waypoints.length === 0) {
      alert('Please create a route before sharing.');
      return;
    }

    // Encode the waypoints data
    const routeData = encodeURIComponent(JSON.stringify(waypoints));
    const shareUrl = `${window.location.origin}/route?route=${routeData}`;

    // Copy to clipboard
    navigator.clipboard.writeText(shareUrl).then(() => {
      alert('Share link copied to clipboard!');
    }).catch(err => {
      console.error('Failed to copy:', err);
      alert('Failed to copy share link. Please try again.');
    });
  };

  if (!isMounted) {
    return <div style={{ height: '100vh', width: '100%' }}>Loading map...</div>;
  }

  return (
    <div style={{ height: '100vh', width: '100%', position: 'relative' }}>
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
      `}} />
      
      {/* Welcome Popup - only show in edit mode */}
      {showWelcomePopup && !viewOnly && (
        <div style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'white',
          padding: '40px',
          borderRadius: '16px',
          boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
          zIndex: 2000,
          maxWidth: '550px',
          width: '90%',
          maxHeight: '90vh',
          overflowY: 'auto'
        }}>
          <h2 style={{ 
            marginTop: 0, 
            color: '#2196F3',
            fontSize: '28px',
            fontWeight: '600',
            marginBottom: '20px',
            fontFamily: 'var(--font-geist-sans)'
          }}>
            Welcome to Route Planner!
          </h2>
          <p style={{ 
            fontSize: '16px', 
            lineHeight: '1.6',
            color: '#4a5568',
            marginBottom: '24px',
            fontFamily: 'var(--font-geist-sans)'
          }}>
            Create and plan your running and biking routes with ease. Here's what you can do:
          </p>
          <ul style={{ 
            paddingLeft: '24px',
            fontSize: '15px',
            lineHeight: '1.8',
            marginBottom: '28px',
            color: '#4a5568',
            fontFamily: 'var(--font-geist-sans)'
          }}>
            <li style={{ marginBottom: '12px' }}>
              <strong style={{ color: '#2196F3' }}>Click anywhere</strong> on the map to add waypoints and build your route.
            </li>
            <li style={{ marginBottom: '12px' }}>
              <strong style={{ color: '#2196F3' }}>Drag waypoints</strong> to fine-tune the path in real time.
            </li>
            <li style={{ marginBottom: '12px' }}>
              <strong style={{ color: '#2196F3' }}>Undo / Redo</strong> with the green/blue buttons if you change your mind.
            </li>
            <li style={{ marginBottom: '12px' }}>
              The route is drawn with a <strong style={{ color: '#2196F3' }}>blue → light-blue gradient</strong> so overlaps are clear.
            </li>
            <li style={{ marginBottom: '12px' }}>
              Press <strong style={{ color: '#2196F3' }}>Play</strong> to watch an orange dot animate along the route.
            </li>
            <li style={{ marginBottom: '12px' }}>
              Scroll to <strong style={{ color: '#2196F3' }}>zoom smoothly</strong>; the map auto-fits the route at playback start.
            </li>
            <li style={{ marginBottom: '12px' }}>
              <strong style={{ color: '#2196F3' }}>Switch map style</strong>: Standard • Satellite • Terrain.
            </li>
            <li style={{ marginBottom: '12px' }}>
              Click the distance badge to toggle <strong style={{ color: '#2196F3' }}>km / miles</strong>.
            </li>
            <li style={{ marginBottom: '12px' }}>
              <strong style={{ color: '#2196F3' }}>Use My Location</strong> to automatically set your current location.
            </li>
          </ul>
          <p style={{ 
            fontSize: '14px', 
            color: '#718096', 
            marginBottom: '28px',
            lineHeight: '1.6',
            padding: '16px',
            backgroundColor: '#f8fafc',
            borderRadius: '8px',
            fontFamily: 'var(--font-geist-sans)'
          }}>
            The route will automatically follow walkable paths and trails for the most realistic experience. 
            You can also play the route by clicking the play button. This website works best on desktop.
          </p>
          <div style={{ display: 'flex', gap: '12px', flexDirection: 'column' }}>
            <button
              onClick={() => {
                requestUserLocation();
                setWaypoints([]);
                setRouteInfo(null);
                setShowWelcomePopup(false);
              }}
              style={{
                padding: '14px 20px',
                backgroundColor: '#2196F3',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '16px',
                width: '100%',
                fontWeight: '500',
                transition: 'all 0.2s ease',
                boxShadow: '0 2px 4px rgba(33, 150, 243, 0.2)',
                fontFamily: 'var(--font-geist-sans)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#1976D2';
                e.currentTarget.style.transform = 'translateY(-1px)';
                e.currentTarget.style.boxShadow = '0 4px 6px rgba(33, 150, 243, 0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#2196F3';
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = '0 2px 4px rgba(33, 150, 243, 0.2)';
              }}
            >
              Use My Location
            </button>
            <button
              onClick={() => {
                setWaypoints([]);
                setRouteInfo(null);
                setShowWelcomePopup(false);
              }}
              style={{
                padding: '14px 20px',
                backgroundColor: '#ffffff',
                color: '#2196F3',
                border: '2px solid #2196F3',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '16px',
                width: '100%',
                fontWeight: '500',
                transition: 'all 0.2s ease',
                fontFamily: 'var(--font-geist-sans)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#f8fafc';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#ffffff';
              }}
            >
              Get Started
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
            Share Route
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
        <div style={{ position: 'absolute', top: '10px', right: '10px', zIndex: 1000 }}>
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
            top: '60px', 
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
          bottom: '20px',
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
          minWidth: '300px'
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

      {/* Trash can area - only show when dragging a marker */}
      {isDraggingMarker && (
        <div
          ref={trashAreaRef}
          style={{
            position: 'absolute',
            bottom: '20px',
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
    </div>
  );
} 