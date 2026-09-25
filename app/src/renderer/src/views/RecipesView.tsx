import { useState } from 'react'
import { ChevronLeft, ChevronRight, Sparkle, SquareSlash } from 'lucide-react'
import type { Recipe, RecipeSection } from '@shared/types'
import { Avatar } from '@/components/Avatar'
import { Spiral } from '@/components/Spiral'
import { api, errorMessage } from '@/lib/api'
import { keys, queryClient, useRecipes } from '@/lib/queries'
import { navigate } from '@/lib/router'
import { useUi } from '@/lib/ui'
import page from './page.module.css'
import styles from './RecipesView.module.css'

const SECTIONS: { id: RecipeSection; title: string }[] = [
  { id: 'anytime', title: 'Popular' },
  { id: 'before', title: 'Before a meeting' },
  { id: 'during', title: 'During a meeting' },
  { id: 'after', title: 'After a meeting' },
]

export function RecipesView() {
  const recipes = useRecipes().data ?? []
  const [expanded, setExpanded] = useState<RecipeSection | null>(null)
  const showToast = useUi((s) => s.showToast)

  const run = async (recipe: Recipe) => {
    try {
      const { threadId } = await api.chat.send({ threadId: null, text: '', noteId: null, recipeId: recipe.id })
      await queryClient.invalidateQueries({ queryKey: keys.thread(threadId) })
      navigate({ name: 'chat', threadId })
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  const sections = expanded ? SECTIONS.filter((s) => s.id === expanded) : SECTIONS
  return (
    <div className={page.scroll}>
      <div className={styles.page}>
        <h1 className={`${styles.heading} display`}>Recipes</h1>
        <p className={styles.intro}>Reusable prompts that run across your meeting notes. Click one to run it.</p>
        {sections.map((section) => {
          const items = recipes.filter((r) => r.section === section.id)
          if (items.length === 0) return null
          return (
            <section key={section.id} className={styles.section}>
              <header className={styles.sectionHeader}>
                {expanded && (
                  <button type="button" className={styles.backLink} onClick={() => setExpanded(null)}>
                    <ChevronLeft size={15} />
                  </button>
                )}
                <h2 className={styles.sectionTitle}>{section.title}</h2>
                {!expanded && (
                  <button type="button" className={styles.seeAll} onClick={() => setExpanded(section.id)}>
                    See all <ChevronRight size={14} strokeWidth={1.8} />
                  </button>
                )}
              </header>
              <div className={expanded ? styles.grid : styles.carousel}>
                {items.map((recipe) => (
                  <RecipeCard key={recipe.id} recipe={recipe} onRun={() => void run(recipe)} />
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function RecipeCard({ recipe, onRun }: { recipe: Recipe; onRun(): void }) {
  return (
    <button type="button" className={styles.card} onClick={onRun}>
      <SquareSlash size={26} strokeWidth={1.4} className={styles.cardIcon} />
      <span className={styles.cardBody}>
        <span className={styles.cardTitle}>{recipe.title}</span>
        <span className={styles.cardDescription}>{recipe.description}</span>
      </span>
      <span className={styles.cardFooter}>
        {recipe.author === 'Granola' ? (
          <span className={styles.granolaMark}>
            <Spiral size={17} color="#b2c248" strokeWidth={2.6} />
          </span>
        ) : (
          <Avatar name={recipe.author} size={22} />
        )}
        <span className={styles.author}>{recipe.author}</span>
        <span className={styles.uses}>
          <Sparkle size={12} strokeWidth={1.8} />
          {compact(recipe.uses)}
        </span>
      </span>
    </button>
  )
}

function compact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`
  return String(n)
}
