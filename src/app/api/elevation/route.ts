import { NextResponse } from 'next/server';

export const POST = async (request: Request) => {
  try {
    const body = await request.json();
    const { locations, api = 'opentopodata' } = body;

    if (!locations || !Array.isArray(locations)) {
      return NextResponse.json(
        { error: 'Invalid locations format' },
        { status: 400 }
      );
    }

    const locationString = locations
      .map((loc: [number, number]) => `${loc[0]},${loc[1]}`)
      .join('|');

    let url: string;
    if (api === 'opentopodata') {
      url = `https://api.opentopodata.org/v1/srtm90m?locations=${locationString}`;
    } else {
      url = `https://api.open-elevation.com/api/v1/lookup?locations=${locationString}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Elevation API responded with status: ${response.status}`);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Elevation API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch elevation data' },
      { status: 500 }
    );
  }
} 