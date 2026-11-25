// Offline reference only. No graph/provider adapter or operational risk inference.
const STATE = 'https://www1.maine.gov/dhhs/mecdc/sites/maine.gov.dhhs.mecdc/files/pfas-fish-scientific-brief-06182024.pdf#page=12';
const DEMO = 'https://sawgraph.com/tracing.html';
const scope = ['waterbody','location','sampleYear','analyte','matrix','species','compositeFish','unit'];
const same = (a,b) => a && b && scope.every(k => a[k] === b[k]);
export function buildKennebecReference(fixture) {
  const empty = {mode:'official_reference_fixture_not_live_graph', graphCoverageVerified:false, graphSampleJoins:[], facilityAttribution:null, currentSafety:null, drinkingWater:null, earthquakeImpact:null, historicalObservations:[]};
  const expected = {waterbody:'Kennebec River',location:'Below Lockwood Dam, Waterville',sampleYear:2023,analyte:'PFOS',matrix:'Fish tissue',species:'Smallmouth bass',compositeFish:5,unit:'ng/g'};
  const rows = fixture?.primary?.observations;
  if (fixture?.status !== 'reference_only' || fixture?.primary?.url !== STATE || fixture?.provider?.url !== DEMO || fixture.provider.liveTransportVerified !== false ||
      !Array.isArray(rows) || rows.length !== 2 || !Array.from(rows).every(r => same(r,expected) && Number.isFinite(r.value))) {
    return {...empty,status:'INVALID_FIXTURE'};
  }
  const ordered = [...rows].sort((a,b)=>a.value-b.value);
  if (ordered[0].value !== 11.8 || ordered[1].value !== 20.4) return {...empty,status:'INVALID_FIXTURE'};
  return {...empty,status:'REFERENCE_ONLY', location:expected.location,
    historicalObservations:ordered.map(r=>({...expected,value:r.value,sourceUrl:STATE})),
    publishedGraphDemo:{sourceUrl:DEMO,role:'context_only',underlyingSampleLineageVerified:false}};
}
