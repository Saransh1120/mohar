-- A route leg can explicitly name the strong room used for custody.
-- Older legs remain unlinked; no room is inferred from a place name.
alter table ref.route_leg
  add column room_id uuid references ref.strong_room(id);

create index route_leg_room_idx on ref.route_leg (room_id)
  where room_id is not null;
