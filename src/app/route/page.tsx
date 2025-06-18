'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import Link from 'next/link';

// Dynamically import MapWrapper with no SSR
const MapWrapper = dynamic(() => import('@/components/MapWrapper'), {
  ssr: false,
});

function RouteContent() {
  const searchParams = useSearchParams();
  const routeParam = searchParams.get('route');
  
  let waypoints: [number, number][] = [];
  if (routeParam) {
    try {
      // Decode and parse the route data
      waypoints = JSON.parse(decodeURIComponent(routeParam));
    } catch (e) {
      console.error('Error parsing route:', e);
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <MapWrapper initialWaypoints={waypoints} viewOnly={true} />
      <Link 
        href="/"
        style={{
          position: 'absolute',
          top: '10px',
          left: '60px',
          zIndex: 1000,
          padding: '10px 20px',
          backgroundColor: '#2196F3',
          color: 'white',
          textDecoration: 'none',
          borderRadius: '4px',
          boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          transition: 'all 0.2s ease',
          fontFamily: 'var(--font-geist-sans)'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = '#1976D2';
          e.currentTarget.style.transform = 'translateY(-1px)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = '#2196F3';
          e.currentTarget.style.transform = 'translateY(0)';
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
          <path d="M19 12H5M12 19l-7-7 7-7"/>
        </svg>
        Create Your Own Route
      </Link>
    </div>
  );
}

export default function RoutePage() {
  return (
    <Suspense fallback={<div>Loading route...</div>}>
      <RouteContent />
    </Suspense>
  );
} 