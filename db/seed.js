const db = require('./dynamo');

async function seed() {
  // Seed programs
  const programs = [
    { name: 'Nature Camps', description: 'Step into the forest — outdoor nature-focused day camps' },
    { name: 'Adventure Days', description: 'Follow the path — adventure-based single-day activities' },
    { name: 'School Programs', description: 'Grow with us — nature education for school groups' },
  ];

  const existing = await db.getAllPrograms();
  const existingNames = new Set(existing.map(p => p.name));

  const programIds = {};
  for (const p of programs) {
    if (existingNames.has(p.name)) {
      const found = existing.find(e => e.name === p.name);
      programIds[p.name] = found.id;
      console.log(`Program "${p.name}" already exists (${found.id})`);
    } else {
      const id = await db.createProgram(p.name, p.description);
      programIds[p.name] = id;
      console.log(`Created program "${p.name}" (${id})`);
    }
  }

  // Seed Nature Camps dates: 4 weeks, M-F, June 15 - July 10, 2026
  const natureCampWeeks = [
    ['2026-06-15','2026-06-16','2026-06-17','2026-06-18','2026-06-19'],
    ['2026-06-22','2026-06-23','2026-06-24','2026-06-25','2026-06-26'],
    ['2026-06-29','2026-06-30','2026-07-01','2026-07-02','2026-07-03'],
    ['2026-07-06','2026-07-07','2026-07-08','2026-07-09','2026-07-10'],
  ];
  const allNatureDates = natureCampWeeks.flat();
  const existingDates = await db.getDatesByProgram(programIds['Nature Camps']);
  const existingDateSet = new Set(existingDates.map(d => d.date));
  const newNatureDates = allNatureDates.filter(d => !existingDateSet.has(d));
  if (newNatureDates.length > 0) {
    await db.addDates(programIds['Nature Camps'], newNatureDates, 12);
    console.log(`Added ${newNatureDates.length} Nature Camps dates`);
  } else {
    console.log('Nature Camps dates already exist');
  }

  // Seed Adventure Days: select Saturdays
  const adventureDates = ['2026-06-20','2026-06-27','2026-07-11','2026-07-18','2026-07-25'];
  const existingAdv = await db.getDatesByProgram(programIds['Adventure Days']);
  const existingAdvSet = new Set(existingAdv.map(d => d.date));
  const newAdvDates = adventureDates.filter(d => !existingAdvSet.has(d));
  if (newAdvDates.length > 0) {
    await db.addDates(programIds['Adventure Days'], newAdvDates, 15);
    console.log(`Added ${newAdvDates.length} Adventure Days dates`);
  } else {
    console.log('Adventure Days dates already exist');
  }

  console.log('Seed complete.');
}

seed().catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});
