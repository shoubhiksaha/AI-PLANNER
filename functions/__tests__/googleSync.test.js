/**
 * Tests for functions/services/googleSync.js
 * Uses jest.isolateModules to ensure a fresh module registry so that
 * `const { logger } = require('firebase-functions/logger')` gets mocked correctly.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Pull in services under isolated module scope where logger is mocked
// ──────────────────────────────────────────────────────────────────────────────
let syncCalendarEvents, syncGoogleTasks, updateCompletedTasks, syncExpensesToSheet, syncHealthToSheet;

beforeAll(() => {
    jest.isolateModules(() => {
        jest.mock('firebase-functions/logger', () => ({
            logger: {
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        }));

        ({
            syncCalendarEvents,
            syncGoogleTasks,
            updateCompletedTasks,
            syncExpensesToSheet,
            syncHealthToSheet
        } = require('../services/googleSync'));
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// syncCalendarEvents
// ──────────────────────────────────────────────────────────────────────────────
describe('syncCalendarEvents', () => {
    const mockCalendar = {
        events: {
            insert: jest.fn().mockResolvedValue({ data: { id: 'event-1' } })
        }
    };

    beforeEach(() => mockCalendar.events.insert.mockClear());

    test('creates events for block items', async () => {
        const plannerData = {
            date: '6-August-2025',
            schedule: [{ time: '9 AM', task: 'Standup', block: true, reminder: false }]
        };
        const counts = await syncCalendarEvents(mockCalendar, plannerData);
        expect(mockCalendar.events.insert).toHaveBeenCalledTimes(1);
        expect(counts.events).toBe(1);
        expect(counts.reminders).toBe(0);
    });

    test('creates reminders for reminder items', async () => {
        const plannerData = {
            date: '6-August-2025',
            schedule: [{ time: '10 AM', task: 'Take meds', block: false, reminder: true }]
        };
        const counts = await syncCalendarEvents(mockCalendar, plannerData);
        expect(mockCalendar.events.insert).toHaveBeenCalledTimes(1);
        expect(counts.reminders).toBe(1);
        expect(counts.events).toBe(0);
    });

    test('event with both block and reminder increments both counters', async () => {
        const plannerData = {
            date: '6-August-2025',
            schedule: [{ time: '11 AM', task: 'Review', block: true, reminder: true }]
        };
        const counts = await syncCalendarEvents(mockCalendar, plannerData);
        expect(counts.events).toBe(1);
        expect(counts.reminders).toBe(1);
    });

    test('skips items where block and reminder are both false', async () => {
        const plannerData = {
            date: '6-August-2025',
            schedule: [{ time: '9 AM', task: 'Freeform note', block: false, reminder: false }]
        };
        await syncCalendarEvents(mockCalendar, plannerData);
        expect(mockCalendar.events.insert).not.toHaveBeenCalled();
    });

    test('skips items where task string is empty', async () => {
        const plannerData = {
            date: '6-August-2025',
            schedule: [{ time: '9 AM', task: '', block: true, reminder: false }]
        };
        await syncCalendarEvents(mockCalendar, plannerData);
        expect(mockCalendar.events.insert).not.toHaveBeenCalled();
    });

    test('skips items where parseDateTime returns null (unparseable time)', async () => {
        const plannerData = {
            date: '6-August-2025',
            schedule: [{ time: 'GARBAGE TIME', task: 'Task', block: true, reminder: false }]
        };
        await syncCalendarEvents(mockCalendar, plannerData);
        expect(mockCalendar.events.insert).not.toHaveBeenCalled();
    });

    test('continues on individual event insert failure without throwing', async () => {
        mockCalendar.events.insert
            .mockRejectedValueOnce(new Error('Rate limit'))
            .mockResolvedValueOnce({ data: { id: 'ok' } });

        const plannerData = {
            date: '6-August-2025',
            schedule: [
                { time: '9 AM', task: 'Failing Event', block: true, reminder: false },
                { time: '10 AM', task: 'OK Event', block: true, reminder: false }
            ]
        };
        const counts = await syncCalendarEvents(mockCalendar, plannerData);
        expect(counts.events).toBe(1);
    });

    test('handles empty schedule gracefully', async () => {
        const counts = await syncCalendarEvents(mockCalendar, { date: '6-August-2025', schedule: [] });
        expect(counts).toEqual({ events: 0, reminders: 0, skippedDuplicates: 0 });
    });

    test('handles missing schedule key', async () => {
        const counts = await syncCalendarEvents(mockCalendar, { date: '6-August-2025' });
        expect(counts).toEqual({ events: 0, reminders: 0, skippedDuplicates: 0 });
    });

    test('event dateTime is local ISO (no Z UTC suffix)', async () => {
        const plannerData = {
            date: '6-August-2025',
            schedule: [{ time: '9 AM', task: 'Meeting', block: true, reminder: false }]
        };
        await syncCalendarEvents(mockCalendar, plannerData);
        const resource = mockCalendar.events.insert.mock.calls[0][0].resource;
        expect(resource.start.dateTime).not.toMatch(/Z$/);
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// syncGoogleTasks
// ──────────────────────────────────────────────────────────────────────────────
describe('syncGoogleTasks', () => {
    const mockTasks = {
        tasks: { 
            insert: jest.fn().mockResolvedValue({ data: {} }),
            list: jest.fn().mockResolvedValue({ data: { items: [] } })
        }
    };

    beforeEach(() => mockTasks.tasks.insert.mockClear());

    test('creates tasks with due date when date is valid (ISO format)', async () => {
        const plannerData = { date: '2025-08-06', todos: [{ task: 'Buy milk', done: false }] };
        const count = await syncGoogleTasks(mockTasks, plannerData);
        expect(count.tasks).toBe(1);
        const callArg = mockTasks.tasks.insert.mock.calls[0][0];
        expect(callArg.requestBody.due).toBeDefined();
    });

    test('omits due date when plannerData.date is not a parseable date', async () => {
        // Previously uncovered branch — line 59
        const plannerData = { date: 'not-a-date', todos: [{ task: 'Buy milk', done: false }] };
        const count = await syncGoogleTasks(mockTasks, plannerData);
        expect(count.tasks).toBe(1);
        const callArg = mockTasks.tasks.insert.mock.calls[0][0];
        expect(callArg.requestBody.due).toBeUndefined();
    });


    test('sets status "completed" when done is true', async () => {
        const plannerData = { date: '2025-08-06', todos: [{ task: 'Done task', done: true }] };
        await syncGoogleTasks(mockTasks, plannerData);
        expect(mockTasks.tasks.insert.mock.calls[0][0].requestBody.status).toBe('completed');
    });

    test('sets status "needsAction" when done is false', async () => {
        const plannerData = { date: '2025-08-06', todos: [{ task: 'Pending', done: false }] };
        await syncGoogleTasks(mockTasks, plannerData);
        expect(mockTasks.tasks.insert.mock.calls[0][0].requestBody.status).toBe('needsAction');
    });

    test('continues on individual task insert failure without throwing', async () => {
        mockTasks.tasks.insert
            .mockRejectedValueOnce(new Error('API error'))
            .mockResolvedValueOnce({ data: {} });

        const plannerData = {
            date: '2025-08-06',
            todos: [{ task: 'Fail', done: false }, { task: 'OK', done: false }]
        };
        const count = await syncGoogleTasks(mockTasks, plannerData);
        expect(count.tasks).toBe(1);
    });

    test('skips empty task strings and returns 0', async () => {
        const count = await syncGoogleTasks(mockTasks, { date: '2025-08-06', todos: [{ task: '', done: false }] });
        expect(count.tasks).toBe(0);
        expect(mockTasks.tasks.insert).not.toHaveBeenCalled();
    });

    test('handles missing todos key', async () => {
        const count = await syncGoogleTasks(mockTasks, { date: '2025-08-06' });
        expect(count.tasks).toBe(0);
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// updateCompletedTasks
// ──────────────────────────────────────────────────────────────────────────────
describe('updateCompletedTasks', () => {
    const mockTasks = {
        tasks: {
            list: jest.fn(),
            patch: jest.fn().mockResolvedValue({})
        }
    };

    beforeEach(() => {
        mockTasks.tasks.list.mockClear();
        mockTasks.tasks.patch.mockClear();
    });

    test('returns 0 if no completed todos', async () => {
        const count = await updateCompletedTasks(mockTasks, { todos: [{ task: 'Pending', done: false }] });
        expect(count).toBe(0);
        expect(mockTasks.tasks.list).not.toHaveBeenCalled();
    });

    test('returns 0 if google tasks list is empty', async () => {
        mockTasks.tasks.list.mockResolvedValue({ data: { items: [] } });
        expect(await updateCompletedTasks(mockTasks, { todos: [{ task: 'Done', done: true }] })).toBe(0);
    });

    test('returns 0 if google tasks list has no items field', async () => {
        mockTasks.tasks.list.mockResolvedValue({ data: {} });
        expect(await updateCompletedTasks(mockTasks, { todos: [{ task: 'Done', done: true }] })).toBe(0);
    });

    test('patches matching google task to completed (case-insensitive)', async () => {
        mockTasks.tasks.list.mockResolvedValue({ data: { items: [{ id: 'task-1', title: 'BUY MILK' }] } });
        const count = await updateCompletedTasks(mockTasks, { todos: [{ task: 'buy milk', done: true }] });
        expect(count).toBe(1);
        expect(mockTasks.tasks.patch).toHaveBeenCalledWith(expect.objectContaining({
            task: 'task-1', requestBody: { status: 'completed' }
        }));
    });

    test('skips tasks with no matching google task', async () => {
        mockTasks.tasks.list.mockResolvedValue({ data: { items: [{ id: 't1', title: 'Something Else' }] } });
        const count = await updateCompletedTasks(mockTasks, { todos: [{ task: 'No match', done: true }] });
        expect(count).toBe(0);
        expect(mockTasks.tasks.patch).not.toHaveBeenCalled();
    });

    test('patches multiple matching tasks', async () => {
        mockTasks.tasks.list.mockResolvedValue({
            data: { items: [{ id: 't1', title: 'Task A' }, { id: 't2', title: 'Task B' }] }
        });
        const count = await updateCompletedTasks(mockTasks, {
            todos: [{ task: 'Task A', done: true }, { task: 'Task B', done: true }]
        });
        expect(count).toBe(2);
        expect(mockTasks.tasks.patch).toHaveBeenCalledTimes(2);
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// syncExpensesToSheet
// ──────────────────────────────────────────────────────────────────────────────
describe('syncExpensesToSheet', () => {
    const mockSheets = {
        spreadsheets: { values: { append: jest.fn().mockResolvedValue({}), get: jest.fn().mockResolvedValue({ data: { values: [] } }) } }
    };

    beforeEach(() => mockSheets.spreadsheets.values.append.mockClear());

    test('returns 0 if no expenses', async () => {
        expect(await syncExpensesToSheet(mockSheets, { expenses: [] }, 'sid')).toBe(0);
    });

    test('returns 0 if expenses key missing', async () => {
        expect(await syncExpensesToSheet(mockSheets, {}, 'sid')).toBe(0);
    });

    test('appends correct rows [date, item, amount]', async () => {
        const plannerData = { date: '2025-08-06', expenses: [{ item: 'Coffee', amount: 150 }] };
        const count = await syncExpensesToSheet(mockSheets, plannerData, 'sid');
        expect(count).toBe(1);
        expect(mockSheets.spreadsheets.values.append.mock.calls[0][0].requestBody.values[0])
            .toEqual(['2025-08-06', 'Coffee', 150]);
    });

    test('throws on genuine API failure so the caller can refund and warn', async () => {
        mockSheets.spreadsheets.values.append.mockRejectedValueOnce(new Error('fail'));
        await expect(
            syncExpensesToSheet(mockSheets, { date: '2025-08-06', expenses: [{ item: 'Tea', amount: 50 }] }, 'sid')
        ).rejects.toThrow('fail');
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// syncHealthToSheet
// ──────────────────────────────────────────────────────────────────────────────
describe('syncHealthToSheet', () => {
    const mockSheets = {
        spreadsheets: { values: { append: jest.fn().mockResolvedValue({}), get: jest.fn().mockResolvedValue({ data: { values: [] } }) } }
    };

    beforeEach(() => mockSheets.spreadsheets.values.append.mockClear());

    test('returns 0 when health is empty object', async () => {
        expect(await syncHealthToSheet(mockSheets, { health: {} }, 'sid')).toBe(0);
    });

    test('returns 0 when health key missing', async () => {
        expect(await syncHealthToSheet(mockSheets, {}, 'sid')).toBe(0);
    });

    test('appends [date, exercise, water, sleep, energy] row', async () => {
        const plannerData = { date: '2025-08-06', health: { exercise: 'Run', water: 8, sleep: 7, energy: 4 } };
        const count = await syncHealthToSheet(mockSheets, plannerData, 'sid');
        expect(count).toBe(1);
        expect(mockSheets.spreadsheets.values.append.mock.calls[0][0].requestBody.values[0])
            .toEqual(['2025-08-06', 'Run', 8, 7, 4]);
    });

    test('uses 0 defaults for missing sub-fields', async () => {
        const plannerData = { date: '2025-08-06', health: { exercise: 'Yoga' } };
        await syncHealthToSheet(mockSheets, plannerData, 'sid');
        expect(mockSheets.spreadsheets.values.append.mock.calls[0][0].requestBody.values[0])
            .toEqual(['2025-08-06', 'Yoga', 0, 0, 0]);
    });

    test('throws on genuine API failure so the caller can refund and warn', async () => {
        mockSheets.spreadsheets.values.append.mockRejectedValueOnce(new Error('fail'));
        await expect(
            syncHealthToSheet(mockSheets, { date: '2025-08-06', health: { exercise: 'Walk', water: 5, sleep: 8, energy: 3 } }, 'sid')
        ).rejects.toThrow('fail');
    });
});
