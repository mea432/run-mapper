'use client';

import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

// Dynamically import MapWrapper with no SSR
const MapWrapper = dynamic(() => import('../../components/MapWrapper'), {
  ssr: false,
});

export default function RoutePage() {
  const searchParams = useSearchParams();
  const routeData = searchParams.get('route');
  
  let initialWaypoints: [number, number][] = [];
  if (routeData) {
    try {
      // Decode and parse the route data
      const decoded = decodeURIComponent(routeData);
      initialWaypoints = JSON.parse(decoded);
    } catch (error) {
      console.error('Failed to parse route data:', error);
    }
  }

  return (
    <main>
      <div style={{ position: 'relative' }}>
        <MapWrapper initialWaypoints={initialWaypoints} viewOnly={true} />
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
    </main>
  );
} 