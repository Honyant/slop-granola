#ifndef CATOMICS_H
#define CATOMICS_H

#include <stdint.h>

// Swift 5.9 has no standard-library atomics. The frame ring only needs acquire/release
// publication of 64-bit counters that each have a single writer, so two functions suffice
// and a package dependency does not.

uint64_t ga_load_acquire(const uint64_t *p);
void ga_store_release(uint64_t *p, uint64_t value);

#endif
