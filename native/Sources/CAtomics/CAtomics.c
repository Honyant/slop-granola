#include "CAtomics.h"

uint64_t ga_load_acquire(const uint64_t *p) {
    return __atomic_load_n(p, __ATOMIC_ACQUIRE);
}

void ga_store_release(uint64_t *p, uint64_t value) {
    __atomic_store_n(p, value, __ATOMIC_RELEASE);
}
